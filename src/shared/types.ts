export const DEMO_INCIDENT_ID = 'INC-1042';
export const NORMAL_ERROR_RATE = 2;

export type IncidentStatus = 'open' | 'resolved';
export type IncidentSeverity = 'SEV-1' | 'SEV-2' | 'SEV-3';
export type RunState =
  | 'IDLE'
  | 'INVESTIGATING'
  | 'ANALYZING'
  | 'SANDBOX_RUNNING'
  | 'ROOT_CAUSE_FOUND'
  | 'AWAITING_APPROVAL'
  | 'REMEDIATING'
  | 'VERIFYING'
  | 'RESOLVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED';

export interface IncidentSnapshot {
  id: string;
  title: string;
  service: string;
  severity: IncidentSeverity;
  openedAt: string;
  description: string;
  normalErrorRate: number;
  failedDeploymentId: string;
  status: IncidentStatus;
  errorRate: number;
}

export interface MetricPoint {
  at: string;
  errorRate: number;
  p95LatencyMs: number;
}

export interface MetricsSnapshot {
  incidentId: string;
  errorRate: number;
  p95LatencyMs: number;
  checkoutSuccessRate: number;
  normalErrorRate: number;
  recovered: boolean;
  series: MetricPoint[];
}

export interface LogRecord {
  at: string;
  level: 'info' | 'warn' | 'error';
  service: string;
  phase: 'before' | 'after';
  deploymentId: string;
  message: string;
  errorCode?: string;
  requestId?: string;
}

export interface DeploymentRecord {
  id: string;
  service: string;
  commit: string;
  deployedAt: string;
  status: 'active' | 'superseded';
  summary: string;
  change: string;
}

export interface RollbackResult {
  deploymentId: string;
  restoredDeploymentId: string;
  appliedAt: string;
  reason: string;
  beforeErrorRate: number;
  expectedErrorRate: number;
}

export interface LabSnapshot {
  incident: IncidentSnapshot;
  metrics: MetricsSnapshot;
  deployments: DeploymentRecord[];
  logs: LogRecord[];
  rolledBack: boolean;
}

export type ActivityKind = 'tool' | 'sandbox' | 'reasoning' | 'approval' | 'system' | 'error';
export type ActivityStatus = 'complete' | 'active' | 'waiting' | 'error';

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  detail?: string;
  toolName?: string;
  code?: string;
}

export interface ApprovalRequest {
  actionId: string;
  toolCallId: string;
  threadId: string;
  deploymentId: string;
  reason: string;
  expectedConsequence: string;
  reversible: boolean;
}

export interface RootCauseFinding {
  title: string;
  detail: string;
  evidence: string[];
}

export interface RunSnapshot {
  id: string;
  state: RunState;
  stateLabel: string;
  sessionId?: string;
  turnId?: string;
  activity: ActivityItem[];
  approval?: ApprovalRequest;
  rootCause?: RootCauseFinding;
  finalMessage?: string;
  error?: string;
  incident: IncidentSnapshot;
  metrics: MetricsSnapshot;
  trueforge: {
    connected: boolean;
    sandboxRequested: boolean;
  };
}
