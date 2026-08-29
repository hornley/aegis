import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  DEMO_INCIDENT_ID,
  NORMAL_ERROR_RATE,
  type DeploymentRecord,
  type IncidentSnapshot,
  type LabSnapshot,
  type LogRecord,
  type MetricsSnapshot,
  type RollbackResult,
} from '../shared/types.js';

const incidentFixtureSchema = z.object({
  id: z.string(),
  title: z.string(),
  service: z.string(),
  severity: z.enum(['SEV-1', 'SEV-2', 'SEV-3']),
  openedAt: z.string(),
  description: z.string(),
  normalErrorRate: z.number(),
  failedDeploymentId: z.string(),
});

const metricPointSchema = z.object({
  at: z.string(),
  errorRate: z.number(),
  p95LatencyMs: z.number(),
});

const metricSetSchema = z.object({
  errorRate: z.number(),
  p95LatencyMs: z.number(),
  checkoutSuccessRate: z.number(),
  series: z.array(metricPointSchema),
});

const metricsFixtureSchema = z.object({
  incidentId: z.string(),
  unit: z.literal('percent'),
  degraded: metricSetSchema,
  recovered: metricSetSchema,
});

const logSchema = z.object({
  at: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  service: z.string(),
  phase: z.enum(['before', 'after']),
  deploymentId: z.string(),
  message: z.string(),
  errorCode: z.string().optional(),
  requestId: z.string().optional(),
});

const deploymentSchema = z.object({
  id: z.string(),
  service: z.string(),
  commit: z.string(),
  deployedAt: z.string(),
  status: z.enum(['active', 'superseded']),
  summary: z.string(),
  change: z.string(),
});

export class IncidentLabError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'approval_required'
      | 'already_resolved'
      | 'invalid_incident'
      | 'invalid_deployment'
      | 'fixture_error',
  ) {
    super(message);
    this.name = 'IncidentLabError';
  }
}

interface IncidentFixture {
  id: string;
  title: string;
  service: string;
  severity: 'SEV-1' | 'SEV-2' | 'SEV-3';
  openedAt: string;
  description: string;
  normalErrorRate: number;
  failedDeploymentId: string;
}

interface MetricsFixture {
  incidentId: string;
  degraded: {
    errorRate: number;
    p95LatencyMs: number;
    checkoutSuccessRate: number;
    series: Array<{ at: string; errorRate: number; p95LatencyMs: number }>;
  };
  recovered: {
    errorRate: number;
    p95LatencyMs: number;
    checkoutSuccessRate: number;
    series: Array<{ at: string; errorRate: number; p95LatencyMs: number }>;
  };
}

interface ApprovalGrant {
  deploymentId: string;
  expiresAt: number;
  runId?: string;
}

export interface IncidentLabOptions {
  fixtureDir?: string;
  now?: () => Date;
  recoveredErrorRate?: number;
}

export class IncidentLab {
  private readonly fixtureDir: string;
  private readonly now: () => Date;
  private readonly incident: IncidentFixture;
  private readonly metrics: MetricsFixture;
  private readonly logs: LogRecord[];
  private readonly deployments: DeploymentRecord[];
  private readonly approvalGrants = new Map<string, ApprovalGrant>();
  private recovered = false;
  private verificationObserved = false;
  private lastRollbackRunId?: string;
  private recoveredErrorRate?: number;

  constructor(options: IncidentLabOptions = {}) {
    this.fixtureDir = resolve(options.fixtureDir ?? resolve(process.cwd(), 'demo'));
    this.now = options.now ?? (() => new Date());
    this.incident = this.readFixture('incidents/checkout-1042.json', incidentFixtureSchema);
    this.metrics = this.readFixture('metrics/checkout.json', metricsFixtureSchema);
    this.logs = this.readFixture('logs/checkout.json', z.array(logSchema));
    this.deployments = this.readFixture('deployments/checkout.json', z.array(deploymentSchema));
    this.recoveredErrorRate = options.recoveredErrorRate;

    if (this.incident.id !== DEMO_INCIDENT_ID || this.metrics.incidentId !== this.incident.id) {
      throw new IncidentLabError('The demo fixtures reference different incident IDs.', 'fixture_error');
    }
  }

  getSnapshot(): LabSnapshot {
    const metrics = this.metricsSnapshot();
    return {
      incident: this.getIncident(this.incident.id),
      metrics,
      deployments: this.getRecentDeployments(this.incident.service, 10),
      logs: this.getLogs(this.incident.id, 100),
      rolledBack: this.recovered,
    };
  }

  getIncident(incidentId: string): IncidentSnapshot {
    this.ensureIncident(incidentId);
    const metrics = this.currentMetricSet();
    return {
      ...this.incident,
      status:
        this.verificationObserved && this.recovered && metrics.errorRate < this.incident.normalErrorRate
          ? 'resolved'
          : 'open',
      errorRate: metrics.errorRate,
    };
  }

  getMetrics(incidentId: string): MetricsSnapshot {
    this.ensureIncident(incidentId);
    if (this.recovered) this.verificationObserved = true;
    return this.metricsSnapshot();
  }

  private metricsSnapshot(): MetricsSnapshot {
    const metrics = this.currentMetricSet();
    return {
      incidentId: this.incident.id,
      errorRate: metrics.errorRate,
      p95LatencyMs: metrics.p95LatencyMs,
      checkoutSuccessRate: metrics.checkoutSuccessRate,
      normalErrorRate: this.incident.normalErrorRate,
      recovered: this.recovered,
      series: metrics.series,
    };
  }

  getLogs(incidentId: string, limit = 50): LogRecord[] {
    this.ensureIncident(incidentId);
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const phase = this.recovered ? 'after' : 'before';
    return this.logs.filter((log) => log.phase === phase).slice(-boundedLimit);
  }

  getRecentDeployments(service: string, limit = 5): DeploymentRecord[] {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 20));
    return this.deployments
      .filter((deployment) => deployment.service === service)
      .map((deployment): DeploymentRecord => {
        const status: DeploymentRecord['status'] = this.recovered
          ? deployment.id === this.restoredDeployment().id
            ? 'active'
            : 'superseded'
          : deployment.id === this.incident.failedDeploymentId
            ? 'active'
            : 'superseded';
        return { ...deployment, status };
      })
      .slice(0, boundedLimit);
  }

  authorizeRollback(deploymentId: string, runId?: string): void {
    this.ensureFailedDeployment(deploymentId);
    this.approvalGrants.set(deploymentId, {
      deploymentId,
      expiresAt: this.now().getTime() + 120_000,
      runId,
    });
  }

  revokeRollback(deploymentId: string): void {
    this.approvalGrants.delete(deploymentId);
  }

  rollbackDeployment(deploymentId: string, reason: string): RollbackResult {
    this.ensureFailedDeployment(deploymentId);
    const grant = this.approvalGrants.get(deploymentId);
    if (!grant || grant.expiresAt < this.now().getTime()) {
      this.approvalGrants.delete(deploymentId);
      throw new IncidentLabError(
        'Rollback blocked: an explicit approval grant is required before the state-changing tool can run.',
        'approval_required',
      );
    }

    if (this.recovered) {
      throw new IncidentLabError('The checkout incident is already recovered.', 'already_resolved');
    }

    this.approvalGrants.delete(deploymentId);
    this.recovered = true;
    this.lastRollbackRunId = grant.runId;
    const beforeErrorRate = this.metrics.degraded.errorRate;
    return {
      deploymentId,
      restoredDeploymentId: this.restoredDeployment().id,
      appliedAt: this.now().toISOString(),
      reason,
      beforeErrorRate,
      expectedErrorRate: this.recoveredErrorRate ?? this.metrics.recovered.errorRate,
    };
  }

  ownsRollback(runId: string): boolean {
    return this.lastRollbackRunId === runId;
  }

  verifyRecovery(incidentId: string): boolean {
    this.ensureIncident(incidentId);
    const metrics = this.metricsSnapshot();
    return this.verificationObserved && metrics.recovered && metrics.errorRate < metrics.normalErrorRate;
  }

  reset(): void {
    this.recovered = false;
    this.verificationObserved = false;
    this.lastRollbackRunId = undefined;
    this.approvalGrants.clear();
  }

  private currentMetricSet(): MetricsFixture['degraded'] {
    if (!this.recovered) return this.metrics.degraded;
    return {
      ...this.metrics.recovered,
      errorRate: this.recoveredErrorRate ?? this.metrics.recovered.errorRate,
      checkoutSuccessRate:
        this.recoveredErrorRate === undefined
          ? this.metrics.recovered.checkoutSuccessRate
          : 100 - this.recoveredErrorRate,
    };
  }

  private restoredDeployment(): DeploymentRecord {
    const restored = this.deployments.find((deployment) => deployment.id !== this.incident.failedDeploymentId);
    if (!restored) {
      throw new IncidentLabError('No known-good deployment exists in the demo fixtures.', 'fixture_error');
    }
    return restored;
  }

  private ensureIncident(incidentId: string): void {
    if (incidentId !== this.incident.id) {
      throw new IncidentLabError(`Unknown incident: ${incidentId}`, 'invalid_incident');
    }
  }

  private ensureFailedDeployment(deploymentId: string): void {
    if (deploymentId !== this.incident.failedDeploymentId) {
      throw new IncidentLabError(`Deployment ${deploymentId} is not the active incident deployment.`, 'invalid_deployment');
    }
  }

  private readFixture<T>(relativePath: string, schema: z.ZodType<T>): T {
    const filePath = resolve(this.fixtureDir, relativePath);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      return schema.parse(raw);
    } catch (error) {
      if (error instanceof IncidentLabError) throw error;
      const detail = error instanceof Error ? error.message : 'unknown fixture error';
      throw new IncidentLabError(`Could not load demo fixture ${relativePath}: ${detail}`, 'fixture_error');
    }
  }
}

export function createIncidentLab(options?: IncidentLabOptions): IncidentLab {
  return new IncidentLab(options);
}

export function isRecoveredMetrics(metrics: MetricsSnapshot): boolean {
  return metrics.recovered && metrics.errorRate < Math.max(metrics.normalErrorRate, NORMAL_ERROR_RATE);
}
