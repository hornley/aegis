import { describe, expect, it } from 'vitest';
import { createIncidentLab, IncidentLabError } from './incidentLab.js';

const fixedNow = () => new Date('2026-08-28T11:00:00.000Z');

describe('IncidentLab', () => {
  it('loads a coherent degraded checkout incident', () => {
    const lab = createIncidentLab({ now: fixedNow });
    const snapshot = lab.getSnapshot();

    expect(snapshot.incident.id).toBe('INC-1042');
    expect(snapshot.incident.status).toBe('open');
    expect(snapshot.metrics.errorRate).toBe(18.4);
    expect(snapshot.logs.every((log) => log.phase === 'before')).toBe(true);
    expect(snapshot.deployments.find((deployment) => deployment.id === '8f31a2')?.status).toBe('active');
  });

  it('blocks a rollback until an approval grant exists', () => {
    const lab = createIncidentLab({ now: fixedNow });

    expect(() => lab.rollbackDeployment('8f31a2', 'The deployment caused the checkout regression.')).toThrowError(
      expect.objectContaining<Partial<IncidentLabError>>({ code: 'approval_required' }),
    );
    expect(lab.getMetrics('INC-1042').recovered).toBe(false);
  });

  it('mutates the lab only after an approval grant and exposes recovered telemetry', () => {
    const lab = createIncidentLab({ now: fixedNow });
    lab.authorizeRollback('8f31a2');
    const result = lab.rollbackDeployment('8f31a2', 'Logs and metrics correlate the regression with this deployment.');

    expect(result.restoredDeploymentId).toBe('7d20c1');
    expect(lab.getIncident('INC-1042').status).toBe('open');
    lab.getMetrics('INC-1042');
    expect(lab.getIncident('INC-1042').status).toBe('resolved');
    expect(lab.getMetrics('INC-1042')).toMatchObject({ errorRate: 1.7, recovered: true });
    expect(lab.getLogs('INC-1042').every((log) => log.phase === 'after')).toBe(true);
    expect(lab.verifyRecovery('INC-1042')).toBe(true);
  });

  it('consumes an approval grant so it cannot be replayed', () => {
    const lab = createIncidentLab({ now: fixedNow });
    lab.authorizeRollback('8f31a2');
    lab.rollbackDeployment('8f31a2', 'Rollback after evidence review.');

    expect(() => lab.rollbackDeployment('8f31a2', 'Replay attempt.')).toThrowError(
      expect.objectContaining<Partial<IncidentLabError>>({ code: 'approval_required' }),
    );
  });

  it('does not call a healthy result resolved when verification is above threshold', () => {
    const lab = createIncidentLab({ now: fixedNow, recoveredErrorRate: 5 });
    lab.authorizeRollback('8f31a2');
    lab.rollbackDeployment('8f31a2', 'Test a failed recovery check.');

    lab.getMetrics('INC-1042');
    expect(lab.getIncident('INC-1042').status).toBe('open');
    expect(lab.verifyRecovery('INC-1042')).toBe(false);
  });
});
