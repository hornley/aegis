import { describe, expect, it } from 'vitest';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { createIncidentLab } from '../domain/incidentLab.js';
import { RunManager } from './runManager.js';
import type { AgentRuntime } from './trueforge.js';

const createdAt = '2026-08-28T11:00:00.000Z';

class FakeRuntime implements AgentRuntime {
  private turn = 0;

  constructor(
    private readonly turns: TrueForgeApi.TurnStreamingEvent[][],
    private readonly onApproval?: (input: TrueForgeApi.UserToolApprovalEvent) => void,
    private readonly sessionError?: Error,
  ) {}

  async createSession(): Promise<{ id: string }> {
    if (this.sessionError) throw this.sessionError;
    return { id: 'session-test' };
  }

  async streamTurn(_sessionId: string, input: TrueForgeApi.TurnInputItem[]): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>> {
    const approval = input[0];
    if (approval?.type === 'user.tool_approval') this.onApproval?.(approval);
    const events = this.turns[this.turn++] ?? [];
    return (async function* stream() {
      for (const event of events) yield event;
    })();
  }
}

function turnCreated(id: string): TrueForgeApi.TurnCreatedEvent {
  return {
    id,
    type: 'turn.created',
    createdAt,
    threadId: null,
    turnId: id,
    previousTurnId: null,
    state: { status: 'running' },
  };
}

function rollbackCall(): TrueForgeApi.ModelMessageEvent {
  return {
    id: 'message-rollback',
    type: 'model.message',
    createdAt,
    threadId: 'main',
    toolCalls: [
      {
        id: 'call-rollback',
        type: 'function',
        function: {
          name: 'rollback_deployment',
          arguments: JSON.stringify({
            deployment_id: '8f31a2',
            reason: 'Deployment 8f31a2 correlates with timeout and pool exhaustion logs.',
          }),
        },
        toolInfo: {
          type: 'mcp',
          name: 'rollback_deployment',
          serverId: 'mcp-test',
          serverName: 'aegis-incident-lab',
        },
      },
    ],
  };
}

function rollbackCallFor(deploymentId: string): TrueForgeApi.ModelMessageEvent {
  const call = rollbackCall();
  const toolCall = call.toolCalls?.[0];
  if (toolCall) toolCall.function.arguments = JSON.stringify({ deployment_id: deploymentId, reason: 'Model-provided rollback proposal.' });
  return call;
}

function sandboxRun(): TrueForgeApi.TurnStreamingEvent[] {
  return [
    {
      id: 'sandbox-created',
      type: 'sandbox.created',
      createdAt,
      threadId: null,
      sandboxId: 'sandbox-test',
    },
    {
      id: 'message-code',
      type: 'model.message',
      createdAt,
      threadId: 'main',
      toolCalls: [
        {
          id: 'call-code',
          type: 'function',
          function: { name: 'run_code', arguments: JSON.stringify({ code: 'print("diagnostic")' }) },
          toolInfo: { type: 'truefoundry-system', name: 'run_code' },
        },
      ],
    },
    {
      id: 'code-response',
      type: 'tool.response',
      createdAt,
      threadId: 'main',
      toolCallId: 'call-code',
      content: '14 records analyzed; ROOT CAUSE correlated with 8f31a2',
    },
  ];
}

function approvalRequired(): TrueForgeApi.ToolApprovalRequiredEvent {
  return {
    id: 'approval-event',
    type: 'tool.approval_required',
    createdAt,
    threadId: 'main',
    toolCalls: [{ id: 'call-rollback', sourceEventId: 'message-rollback' }],
  };
}

function turnDone(id: string, output: TrueForgeApi.ModelMessageEvent | null = null): TrueForgeApi.TurnDoneEvent {
  return {
    id,
    type: 'turn.done',
    createdAt,
    threadId: null,
    state: {
      status: 'done',
      completedAt: createdAt,
      output,
      requiredActions: [],
    },
  };
}

function finalMessage(id: string, content: string): TrueForgeApi.ModelMessageEvent {
  return {
    id,
    type: 'model.message',
    createdAt,
    threadId: 'main',
    content,
    finishReason: 'stop',
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

describe('RunManager', () => {
  it('rejects approval for a deployment other than the active incident deployment', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([[rollbackCallFor('7d20c1'), approvalRequired(), turnDone('turn-done')]]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));

    const run = manager.start('Investigate and fix the checkout incident.');
    await waitFor(() => manager.get(run.id)?.state === 'FAILED');

    expect(manager.get(run.id)?.error).toContain('active incident deployment is 8f31a2');
    expect(lab.getIncident('INC-1042').status).toBe('open');
  });

  it('marks the command activity failed when TrueForge cannot create a session', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([], undefined, new Error('TrueForge is unavailable.'));
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'FAILED');

    expect(manager.get(run.id)?.activity).toContainEqual(
      expect.objectContaining({ id: 'run-started', status: 'error', title: 'Incident command failed' }),
    );
  });

  it('pauses on a real approval event and rejection leaves the incident open', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([
      [turnCreated('turn-one'), ...sandboxRun(), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
      [finalMessage('rejected-message', 'The rollback was rejected. No remediation was executed.'), turnDone('turn-two-done')],
    ]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'AWAITING_APPROVAL');
    const pending = manager.get(run.id);
    expect(pending?.approval?.deploymentId).toBe('8f31a2');

    await manager.decide(run.id, 'deny');
    await waitFor(() => manager.get(run.id)?.state === 'REJECTED');

    expect(manager.get(run.id)?.incident.status).toBe('open');
    expect(lab.getMetrics('INC-1042').recovered).toBe(false);
    expect(manager.get(run.id)?.activity.some((item) => item.title === 'Rollback rejected')).toBe(true);
  });

  it('projects the generated sandbox diagnostic into the activity trace', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([
      [
        turnCreated('turn-one'),
        {
          id: 'sandbox-created',
          type: 'sandbox.created',
          createdAt,
          threadId: null,
          sandboxId: 'sandbox-test',
        },
        {
          id: 'message-code',
          type: 'model.message',
          createdAt,
          threadId: 'main',
          toolCalls: [
            {
              id: 'call-code',
              type: 'function',
              function: { name: 'run_code', arguments: JSON.stringify({ code: 'print("diagnostic")' }) },
              toolInfo: { type: 'truefoundry-system', name: 'run_code' },
            },
          ],
        },
        {
          id: 'code-response',
          type: 'tool.response',
          createdAt,
          threadId: 'main',
          toolCallId: 'call-code',
          content: '14 records analyzed; ROOT CAUSE correlated with 8f31a2',
        },
        rollbackCall(),
        approvalRequired(),
        turnDone('turn-one-done'),
      ],
    ]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'AWAITING_APPROVAL');
    const sandboxActivity = manager.get(run.id)?.activity.find((item) => item.id === 'tool:call-code');
    expect(sandboxActivity).toMatchObject({ kind: 'sandbox', code: 'print("diagnostic")' });
    expect(manager.get(run.id)?.rootCause?.title).toContain('8f31a2');
  });

  it('surfaces a sandbox failure without claiming analysis completed', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([
      [
        turnCreated('turn-one'),
        {
          id: 'message-code',
          type: 'model.message',
          createdAt,
          threadId: 'main',
          toolCalls: [
            {
              id: 'call-code',
              type: 'function',
              function: { name: 'run_code', arguments: JSON.stringify({ code: 'raise RuntimeError()' }) },
              toolInfo: { type: 'truefoundry-system', name: 'run_code' },
            },
          ],
        },
        {
          id: 'code-failure',
          type: 'tool.response',
          createdAt,
          threadId: 'main',
          toolCallId: 'call-code',
          content: JSON.stringify({ error: 'Sandbox execution timed out.' }),
        },
      ],
    ]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'FAILED');
    expect(manager.get(run.id)?.error).toContain('Sandbox execution timed out');
  });

  it('authorizes, executes, and verifies an approved rollback', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const metricsCall: TrueForgeApi.ModelMessageEvent = {
      id: 'message-metrics',
      type: 'model.message',
      createdAt,
      threadId: 'main',
      toolCalls: [
        {
          id: 'call-metrics',
          type: 'function',
          function: { name: 'get_metrics', arguments: JSON.stringify({ incident_id: 'INC-1042' }) },
          toolInfo: {
            type: 'mcp',
            name: 'get_metrics',
            serverId: 'mcp-test',
            serverName: 'aegis-incident-lab',
          },
        },
      ],
    };
    const runtime = new FakeRuntime(
      [
      [turnCreated('turn-one'), ...sandboxRun(), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
      [
        {
          id: 'rollback-response',
          type: 'tool.response',
          createdAt,
          threadId: 'main',
          toolCallId: 'call-rollback',
          content: JSON.stringify({ restoredDeploymentId: '7d20c1' }),
        },
        metricsCall,
        {
          id: 'metrics-response',
          type: 'tool.response',
          createdAt,
          threadId: 'main',
          toolCallId: 'call-metrics',
          content: JSON.stringify({ errorRate: 1.7, recovered: true }),
        },
        finalMessage('resolved-message', 'RESOLVED: rollback completed and verification passed.'),
        turnDone('turn-two-done'),
      ],
      ],
      (approval) => {
        if (approval.approval.status === 'allow') lab.rollbackDeployment('8f31a2', 'Approved by test operator.');
      },
    );
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'AWAITING_APPROVAL');
    await manager.decide(run.id, 'allow');
    await waitFor(() => manager.get(run.id)?.state === 'RESOLVED');

    expect(manager.get(run.id)?.metrics).toMatchObject({ errorRate: 1.7, recovered: true });
    expect(manager.get(run.id)?.activity.some((item) => item.title === 'Incident resolved')).toBe(true);
  });

  it('reports remediation failure instead of claiming recovery', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([
      [turnCreated('turn-one'), ...sandboxRun(), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
      [
        {
          id: 'rollback-failure',
          type: 'tool.response',
          createdAt,
          threadId: 'main',
          toolCallId: 'call-rollback',
          content: JSON.stringify({ error: 'Rollback provider rejected the deployment.' }),
        },
      ],
    ]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'AWAITING_APPROVAL');
    await manager.decide(run.id, 'allow');
    await waitFor(() => manager.get(run.id)?.state === 'FAILED');

    expect(manager.get(run.id)?.error).toContain('Rollback provider rejected');
    expect(lab.getMetrics('INC-1042').recovered).toBe(false);
  });

  it('reports verification failure instead of claiming resolved', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt), recoveredErrorRate: 5 });
    const runtime = new FakeRuntime(
      [
        [turnCreated('turn-one'), ...sandboxRun(), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
        [
          {
            id: 'rollback-response',
            type: 'tool.response',
            createdAt,
            threadId: 'main',
            toolCallId: 'call-rollback',
            content: JSON.stringify({ restoredDeploymentId: '7d20c1' }),
          },
          {
            id: 'message-metrics-failure',
            type: 'model.message',
            createdAt,
            threadId: 'main',
            toolCalls: [
              {
                id: 'call-metrics-failure',
                type: 'function',
                function: { name: 'get_metrics', arguments: JSON.stringify({ incident_id: 'INC-1042' }) },
                toolInfo: {
                  type: 'mcp',
                  name: 'get_metrics',
                  serverId: 'mcp-test',
                  serverName: 'aegis-incident-lab',
                },
              },
            ],
          },
          {
            id: 'metrics-response',
            type: 'tool.response',
            createdAt,
            threadId: 'main',
            toolCallId: 'call-metrics-failure',
            content: JSON.stringify({ errorRate: 5, recovered: true }),
          },
          finalMessage('failed-verification-message', 'Verification did not reach the normal threshold.'),
          turnDone('turn-two-done'),
        ],
      ],
      (approval) => {
        if (approval.approval.status === 'allow') lab.rollbackDeployment('8f31a2', 'Approved by test operator.');
      },
    );
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'AWAITING_APPROVAL');
    await manager.decide(run.id, 'allow');
    await waitFor(() => manager.get(run.id)?.state === 'FAILED');

    expect(manager.get(run.id)?.error).toContain('verified recovery');
    expect(manager.get(run.id)?.state).not.toBe('RESOLVED');
  });

  it('prevents cross-run verification: one run rollback does not resolve another run', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const makeRuntime = () =>
      new FakeRuntime(
        [
          [turnCreated('turn-one'), ...sandboxRun(), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
          [
            {
              id: 'rollback-response',
              type: 'tool.response',
              createdAt,
              threadId: 'main',
              toolCallId: 'call-rollback',
              content: JSON.stringify({ restoredDeploymentId: '7d20c1' }),
            },
            {
              id: 'message-metrics',
              type: 'model.message',
              createdAt,
              threadId: 'main',
              toolCalls: [
                {
                  id: 'call-metrics',
                  type: 'function',
                  function: { name: 'get_metrics', arguments: JSON.stringify({ incident_id: 'INC-1042' }) },
                  toolInfo: {
                    type: 'mcp',
                    name: 'get_metrics',
                    serverId: 'mcp-test',
                    serverName: 'aegis-incident-lab',
                  },
                },
              ],
            },
            {
              id: 'metrics-response',
              type: 'tool.response',
              createdAt,
              threadId: 'main',
              toolCallId: 'call-metrics',
              content: JSON.stringify({ errorRate: 1.7, recovered: true }),
            },
            finalMessage('resolved-message', 'RESOLVED: rollback completed and verification passed.'),
            turnDone('turn-two-done'),
          ],
        ],
        (approval) => {
          if (approval.approval.status === 'allow') lab.rollbackDeployment('8f31a2', 'Approved by test operator.');
        },
      );

    const manager = new RunManager(lab, makeRuntime(), () => new Date(createdAt));

    const runA = manager.start('Investigate and fix the checkout incident.');
    await waitFor(() => manager.get(runA.id)?.state === 'AWAITING_APPROVAL');
    await manager.decide(runA.id, 'allow');
    await waitFor(() => manager.get(runA.id)?.state === 'RESOLVED');

    lab.reset();

    const runtimeB = makeRuntime();
    const managerB = new RunManager(lab, runtimeB, () => new Date(createdAt));
    const runB = managerB.start('Investigate and fix the checkout incident.');
    await waitFor(() => managerB.get(runB.id)?.state === 'AWAITING_APPROVAL');
    await managerB.decide(runB.id, 'deny');
    await waitFor(() => managerB.get(runB.id)?.state === 'REJECTED');

    expect(manager.get(runA.id)?.state).toBe('RESOLVED');
    expect(managerB.get(runB.id)?.state).toBe('REJECTED');
    expect(lab.getIncident('INC-1042').status).toBe('open');
  });

  it('fails closed when rollback is proposed before a completed sandbox diagnostic', async () => {
    const lab = createIncidentLab({ now: () => new Date(createdAt) });
    const runtime = new FakeRuntime([
      [turnCreated('turn-one'), rollbackCall(), approvalRequired(), turnDone('turn-one-done')],
    ]);
    const manager = new RunManager(lab, runtime, () => new Date(createdAt));
    const run = manager.start('Investigate and fix the checkout incident.');

    await waitFor(() => manager.get(run.id)?.state === 'FAILED');

    expect(manager.get(run.id)?.error).toContain('before completing the required read-only sandbox diagnostic');
    expect(lab.getMetrics('INC-1042').recovered).toBe(false);
    expect(lab.getIncident('INC-1042').status).toBe('open');
  });
});
