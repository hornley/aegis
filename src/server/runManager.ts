import { randomUUID } from 'node:crypto';
import {
  isEventDelta,
  mergeEventDelta,
  type TrueForgeApi,
} from '@truefoundry/trueforge-sdk';
import {
  isRecoveredMetrics,
  type IncidentLab,
} from '../domain/incidentLab.js';
import type {
  ActivityItem,
  ActivityKind,
  ActivityStatus,
  ApprovalRequest,
  RootCauseFinding,
  RunSnapshot,
  RunState,
} from '../shared/types.js';
import { DEMO_INCIDENT_ID } from '../shared/types.js';
import type { AgentRuntime } from './trueforge.js';

type SnapshotListener = (snapshot: RunSnapshot) => void;

interface PendingApprovalDetails {
  request: ApprovalRequest;
  toolName: string;
}

interface RunRecord {
  id: string;
  sessionId?: string;
  turnId?: string;
  state: RunState;
  activity: ActivityItem[];
  events: Map<string, TrueForgeApi.TurnStreamingEvent>;
  listeners: Set<SnapshotListener>;
  approval?: PendingApprovalDetails;
  rootCause?: RootCauseFinding;
  finalMessage?: string;
  error?: string;
  verificationObserved: boolean;
  rejecting: boolean;
  busy: boolean;
}

const STATE_LABELS: Record<RunState, string> = {
  IDLE: 'Ready',
  INVESTIGATING: 'Investigating',
  ANALYZING: 'Analyzing evidence',
  SANDBOX_RUNNING: 'Running sandbox',
  ROOT_CAUSE_FOUND: 'Root cause identified',
  AWAITING_APPROVAL: 'Awaiting approval',
  REMEDIATING: 'Executing remediation',
  VERIFYING: 'Verifying recovery',
  RESOLVED: 'Resolved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  FAILED: 'Run failed',
};

const READ_TOOL_NAMES = new Set([
  'get_incident',
  'get_metrics',
  'get_logs',
  'get_recent_deployments',
]);

const SANDBOX_NAME_PATTERN = /sandbox|code|python|shell|execute/i;

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly now: () => Date;

  constructor(
    private readonly lab: IncidentLab,
    private readonly runtime: AgentRuntime,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  start(message: string): RunSnapshot {
    this.lab.reset();
    const run: RunRecord = {
      id: randomUUID(),
      state: 'INVESTIGATING',
      activity: [
        this.activity('run-started', 'system', 'active', 'Incident command started', 'TrueForge is opening an agent session.'),
      ],
      events: new Map(),
      listeners: new Set(),
      verificationObserved: false,
      rejecting: false,
      busy: false,
    };
    this.runs.set(run.id, run);
    this.publish(run);
    void this.beginRun(run, message);
    return this.snapshot(run);
  }

  get(runId: string): RunSnapshot | undefined {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  subscribe(runId: string, listener: SnapshotListener): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => undefined;
    run.listeners.add(listener);
    listener(this.snapshot(run));
    return () => run.listeners.delete(listener);
  }

  async decide(runId: string, decision: 'allow' | 'deny'): Promise<RunSnapshot> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} was not found.`);
    if (!run.approval) throw new Error('There is no pending approval for this run.');
    if (run.busy) throw new Error('The agent is still processing the previous turn.');

    const pending = run.approval;
    if (decision === 'allow') this.lab.authorizeRollback(pending.request.deploymentId);
    run.approval = undefined;
    const approval: TrueForgeApi.UserToolApprovalEvent = {
      type: 'user.tool_approval',
      threadId: pending.request.threadId,
      toolCallId: pending.request.toolCallId,
      approval:
        decision === 'allow'
          ? { status: 'allow' }
          : { status: 'deny', reason: 'Operator rejected the proposed rollback.' },
    };

    if (decision === 'allow') {
      this.setState(run, 'REMEDIATING');
      this.upsertActivity(
        run,
        this.activity(
          `approval:${pending.request.toolCallId}`,
          'approval',
          'complete',
          'Rollback approved',
          'TrueForge is resuming the paused session with the operator approval.',
        ),
      );
    } else {
      run.rejecting = true;
      this.setState(run, 'REJECTED');
      this.upsertActivity(
        run,
        this.activity(
          `approval:${pending.request.toolCallId}`,
          'approval',
          'complete',
          'Rollback rejected',
          'No state-changing tool was authorized or executed.',
        ),
      );
    }
    this.publish(run);
    void this.resumeAfterApproval(run, approval, decision, pending.request.deploymentId);
    return this.snapshot(run);
  }

  private async beginRun(run: RunRecord, message: string): Promise<void> {
    try {
      const session = await this.runtime.createSession();
      run.sessionId = session.id;
      this.upsertActivity(
        run,
        this.activity('run-started', 'system', 'complete', 'Incident command started', 'TrueForge is opening an agent session.'),
      );
      this.upsertActivity(
        run,
        this.activity('session-created', 'system', 'complete', 'TrueForge session connected', 'Agent context is persisted in the TrueForge session.'),
      );
      this.publish(run);
      await this.consumeTurn(run, [{ type: 'user.message', content: message }]);
    } catch (error) {
      this.fail(run, this.errorMessage(error, 'TrueForge could not start the incident run.'));
    }
  }

  private async resumeAfterApproval(
    run: RunRecord,
    approval: TrueForgeApi.UserToolApprovalEvent,
    decision: 'allow' | 'deny',
    deploymentId: string,
  ): Promise<void> {
    try {
      if (!run.sessionId) throw new Error('The TrueForge session ID is missing.');
      await this.consumeTurn(run, [approval]);
    } catch (error) {
      if (decision === 'allow') this.lab.revokeRollback(deploymentId);
      this.fail(run, this.errorMessage(error, 'TrueForge could not resume the approval turn.'));
    }
  }

  private async consumeTurn(run: RunRecord, input: TrueForgeApi.TurnInputItem[]): Promise<void> {
    if (!run.sessionId) throw new Error('The TrueForge session ID is missing.');
    run.busy = true;
    try {
      const stream = await this.runtime.streamTurn(run.sessionId, input);
      for await (const event of stream) this.acceptEvent(run, event);
    } finally {
      run.busy = false;
      this.publish(run);
    }
  }

  private acceptEvent(run: RunRecord, event: TrueForgeApi.TurnStreamingEvent): void {
    if (isEventDelta(event)) {
      const base = run.events.get(event.id);
      if (base) {
        mergeEventDelta(base, event);
        if (base.type === 'model.message') this.handleModelMessage(run, base);
      }
      return;
    }

    run.events.set(event.id, event);
    switch (event.type) {
      case 'turn.created':
        run.turnId = event.turnId;
        this.upsertActivity(run, this.activity(event.id, 'system', 'complete', 'TrueForge turn started'));
        break;
      case 'mcp.initialize':
        this.upsertActivity(
          run,
          this.activity(
            event.id,
            'system',
            'complete',
            'Connected to incident MCP',
            event.mcpServers.map((server) => server.name).join(', '),
          ),
        );
        break;
      case 'sandbox.created':
        this.setState(run, 'SANDBOX_RUNNING');
        this.upsertActivity(
          run,
          this.activity(event.id, 'sandbox', 'complete', 'TrueForge sandbox provisioned', 'Isolated execution is ready; credentials remain outside the sandbox.'),
        );
        break;
      case 'model.message':
        this.handleModelMessage(run, event);
        break;
      case 'tool.response':
        this.handleToolResponse(run, event);
        break;
      case 'tool.approval_required':
        this.handleApprovalRequired(run, event);
        break;
      case 'turn.done':
        this.handleTurnDone(run, event);
        break;
      case 'mcp.auth_required':
        this.fail(run, 'The incident MCP connector needs authorization before the agent can continue.');
        break;
      case 'tool.response_required':
        this.fail(run, 'The agent requested an unsupported client-side response.');
        break;
      case 'thread.created':
      case 'thread.done':
        this.upsertActivity(run, this.activity(event.id, 'system', 'complete', `TrueForge ${event.type === 'thread.created' ? 'subagent started' : 'subagent finished'}`, event.title));
        break;
    }
    this.publish(run);
  }

  private handleModelMessage(run: RunRecord, event: TrueForgeApi.ModelMessageEvent): void {
    const text = extractText(event.content);
    if (text && event.finishReason === 'stop' && !event.toolCalls?.length) run.finalMessage = text;
    if (text) this.captureRootCause(run, text);

    for (const call of event.toolCalls ?? []) {
      const name = call.toolInfo.name;
      const sandbox = isSandboxTool(call);
      const kind: ActivityKind = sandbox ? 'sandbox' : name === 'rollback_deployment' ? 'approval' : 'tool';
      if (sandbox) this.setState(run, 'SANDBOX_RUNNING');
      else if (name === 'rollback_deployment') {
        if (!run.rejecting) this.setState(run, 'ROOT_CAUSE_FOUND');
      } else if (READ_TOOL_NAMES.has(name) && run.state !== 'REMEDIATING' && run.state !== 'VERIFYING') {
        this.setState(run, 'ANALYZING');
      }

      const args = parseObject(call.function.arguments);
      this.upsertActivity(
        run,
        this.activity(
          `tool:${call.id}`,
          kind,
          'active',
          toolLabel(name),
          toolCallDetail(name, args),
          name,
          sandbox ? extractCode(args) : undefined,
        ),
      );
    }
  }

  private handleToolResponse(run: RunRecord, event: TrueForgeApi.ToolResponseEvent): void {
    const toolName = this.findToolName(run, event.toolCallId);
    const parsed = parseObject(event.content);
    const failed = Boolean(parsed && typeof parsed.error === 'string');
    const sandbox = toolName ? isSandboxName(toolName) : false;
    const previousActivity = run.activity.find((item) => item.id === `tool:${event.toolCallId}`);

    this.upsertActivity(
      run,
      this.activity(
        `tool:${event.toolCallId}`,
        sandbox ? 'sandbox' : toolName === 'rollback_deployment' ? 'approval' : 'tool',
        failed ? 'error' : 'complete',
        failed ? `${toolLabel(toolName ?? 'Tool')} failed` : `${toolLabel(toolName ?? 'Tool')} returned`,
        failed ? String(parsed?.error) : toolResponseDetail(toolName, parsed, event.content),
        toolName,
        previousActivity?.code,
      ),
    );

    if (failed) {
      this.fail(run, String(parsed?.error));
      return;
    }

    if (sandbox) {
      this.setState(run, 'ANALYZING');
      if (event.content.includes('ROOT CAUSE') || event.content.includes('root_cause')) this.setFindingFromLab(run);
    } else if (toolName === 'rollback_deployment') {
      this.setState(run, 'VERIFYING');
    } else if (toolName === 'get_metrics') {
      try {
        const metrics = this.lab.getMetrics(DEMO_INCIDENT_ID);
        if (isRecoveredMetrics(metrics)) {
          run.verificationObserved = true;
          this.setState(run, 'VERIFYING');
        }
      } catch (error) {
        this.fail(run, this.errorMessage(error, 'Verification metrics could not be read.'));
      }
    }
  }

  private handleApprovalRequired(run: RunRecord, event: TrueForgeApi.ToolApprovalRequiredEvent): void {
    const pending = event.toolCalls
      .map((ref) => {
        const message = run.events.get(ref.sourceEventId);
        if (!message || message.type !== 'model.message') return undefined;
        const call = message.toolCalls?.find((candidate) => candidate.id === ref.id);
        if (!call || call.toolInfo.name !== 'rollback_deployment') return undefined;
        const args = parseObject(call.function.arguments);
        const deploymentId = stringValue(args?.deployment_id);
        if (!deploymentId) return undefined;
        return {
          request: {
            actionId: `${run.id}:${ref.id}`,
            toolCallId: ref.id,
            threadId: event.threadId,
            deploymentId,
            reason: stringValue(args?.reason) ?? 'The agent provided no rollback reason.',
            expectedConsequence: 'Restore the last known-good checkout deployment and re-read live metrics.',
            reversible: Boolean(true),
          },
          toolName: call.toolInfo.name,
        } satisfies PendingApprovalDetails;
      })
      .find((candidate): candidate is PendingApprovalDetails => Boolean(candidate));

    if (!pending) {
      this.fail(run, 'TrueForge requested approval for an unsupported state-changing tool.');
      return;
    }

    run.approval = pending;
    this.setFindingFromLab(run);
    this.setState(run, 'AWAITING_APPROVAL');
    this.upsertActivity(
      run,
      this.activity(
        `approval:${pending.request.toolCallId}`,
        'approval',
        'waiting',
        'Human approval required',
        `Rollback ${pending.request.deploymentId} is paused at the TrueForge approval boundary.`,
      ),
    );
  }

  private handleTurnDone(run: RunRecord, event: TrueForgeApi.TurnDoneEvent): void {
    if (event.state.status === 'error') {
      this.fail(run, event.state.message);
      return;
    }
    if (event.state.status === 'cancelled') {
      run.state = 'CANCELLED';
      run.error = `TrueForge cancelled the turn: ${event.state.reason}.`;
      this.upsertActivity(run, this.activity(event.id, 'error', 'error', 'Agent turn cancelled', run.error));
      return;
    }

    if (event.state.output) {
      const output = extractText(event.state.output.content);
      if (output) {
        run.finalMessage = output;
        this.captureRootCause(run, output);
      }
    }

    if (run.approval) return;
    if (run.rejecting) {
      run.state = 'REJECTED';
      return;
    }
    if (run.verificationObserved && this.lab.verifyRecovery(DEMO_INCIDENT_ID)) {
      run.state = 'RESOLVED';
      this.upsertActivity(run, this.activity('resolved', 'system', 'complete', 'Incident resolved', 'Verification passed: the error rate is below the normal threshold.'));
      return;
    }
    if (run.state !== 'FAILED' && run.state !== 'RESOLVED') {
      this.fail(run, 'The agent ended without a verified recovery.');
    }
  }

  private captureRootCause(run: RunRecord, text: string): void {
    if (/root cause/i.test(text)) this.setFindingFromLab(run, text);
  }

  private setFindingFromLab(run: RunRecord, agentText?: string): void {
    if (run.rootCause) return;
    const lab = this.lab.getSnapshot();
    const failed = lab.deployments.find((deployment) => deployment.id === lab.incident.failedDeploymentId);
    const errors = lab.logs.filter((log) => log.level === 'error');
    run.rootCause = {
      title: `Deployment ${lab.incident.failedDeploymentId} exhausted payment connections`,
      detail:
        agentText?.replace(/\s+/g, ' ').trim().slice(0, 280) ||
        failed?.change ||
        'The diagnostic correlated the checkout error spike with the latest deployment.',
      evidence: [
        `Error rate reached ${lab.metrics.errorRate}% against a ${lab.incident.normalErrorRate}% normal threshold.`,
        `${errors.length} recent error logs contain payment timeout or pool exhaustion signals.`,
        `Deployment ${lab.incident.failedDeploymentId} introduced the changed payment connection pool.`,
      ],
    };
  }

  private findToolName(run: RunRecord, toolCallId: string): string | undefined {
    for (const event of run.events.values()) {
      if (event.type !== 'model.message') continue;
      const call = event.toolCalls?.find((candidate) => candidate.id === toolCallId);
      if (call) return call.toolInfo.name;
    }
    return undefined;
  }

  private setState(run: RunRecord, state: RunState): void {
    if (run.state === 'FAILED' || run.state === 'CANCELLED') return;
    if (run.rejecting && state !== 'REJECTED') return;
    run.state = state;
  }

  private fail(run: RunRecord, message: string): void {
    run.state = 'FAILED';
    run.error = message;
    run.approval = undefined;
    if (run.activity.some((item) => item.id === 'run-started' && item.status === 'active')) {
      this.upsertActivity(
        run,
        this.activity('run-started', 'error', 'error', 'Incident command failed', message),
      );
    }
    this.upsertActivity(run, this.activity(`failure:${run.id}`, 'error', 'error', 'Agent run failed', message));
    this.publish(run);
  }

  private upsertActivity(run: RunRecord, item: ActivityItem): void {
    const index = run.activity.findIndex((existing) => existing.id === item.id);
    if (index === -1) run.activity.push(item);
    else run.activity[index] = item;
  }

  private activity(
    id: string,
    kind: ActivityKind,
    status: ActivityStatus,
    title: string,
    detail?: string,
    toolName?: string,
    code?: string,
  ): ActivityItem {
    return { id, at: this.now().toISOString(), kind, status, title, detail, toolName, code };
  }

  private publish(run: RunRecord): void {
    const snapshot = this.snapshot(run);
    for (const listener of run.listeners) listener(snapshot);
  }

  private snapshot(run: RunRecord): RunSnapshot {
    const lab = this.lab.getSnapshot();
    return {
      id: run.id,
      state: run.state,
      stateLabel: STATE_LABELS[run.state],
      sessionId: run.sessionId,
      turnId: run.turnId,
      activity: run.activity,
      approval: run.approval?.request,
      rootCause: run.rootCause,
      finalMessage: run.finalMessage,
      error: run.error,
      incident: lab.incident,
      metrics: lab.metrics,
      trueforge: {
        connected: Boolean(run.sessionId),
        sandboxRequested: true,
      },
    };
  }

  private errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }
}

function extractText(content: TrueForgeApi.ModelMessageEvent['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ('text' in part ? part.text : 'refusal' in part ? part.refusal : ''))
    .join('')
    .trim();
}

function parseObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isSandboxTool(call: TrueForgeApi.ToolCall): boolean {
  return isSandboxName(call.toolInfo.name) || call.toolInfo.type === 'truefoundry-system';
}

function isSandboxName(name: string): boolean {
  return SANDBOX_NAME_PATTERN.test(name) && !READ_TOOL_NAMES.has(name) && name !== 'rollback_deployment';
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    get_incident: 'Retrieved incident',
    get_metrics: 'Retrieved checkout metrics',
    get_logs: 'Retrieved application logs',
    get_recent_deployments: 'Inspected recent deployments',
    rollback_deployment: 'Rollback deployment',
  };
  return labels[name] ?? `Called ${name}`;
}

function toolCallDetail(name: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  if (name === 'get_incident' || name === 'get_metrics' || name === 'get_logs') {
    return stringValue(args.incident_id);
  }
  if (name === 'get_recent_deployments') return stringValue(args.service);
  if (name === 'rollback_deployment') return stringValue(args.reason);
  return undefined;
}

function extractCode(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  for (const key of ['code', 'script', 'command']) {
    const value = stringValue(args[key]);
    if (value) return value.slice(0, 5000);
  }
  return undefined;
}

function toolResponseDetail(name: string | undefined, parsed: Record<string, unknown> | undefined, raw: string): string {
  if (!parsed) return raw.slice(0, 240);
  if (name === 'get_logs' && Array.isArray(parsed.logs)) return `${parsed.logs.length} log records returned for the diagnostic.`;
  if (name === 'get_metrics' && typeof parsed.errorRate === 'number') {
    return `Error rate ${parsed.errorRate}% • p95 ${parsed.p95LatencyMs ?? '?'} ms${parsed.recovered ? ' • recovery signal confirmed' : ''}.`;
  }
  if (name === 'get_recent_deployments' && Array.isArray(parsed.deployments)) return `${parsed.deployments.length} recent deployments returned.`;
  if (name === 'rollback_deployment' && typeof parsed.restoredDeploymentId === 'string') return `Restored known-good deployment ${parsed.restoredDeploymentId}.`;
  return raw.slice(0, 240);
}
