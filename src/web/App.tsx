import { useEffect, useRef, useState } from 'react';
import {
  ActivityIcon,
  ArrowClockwise,
  Check,
  CheckCircle,
  GitBranch,
  LockKey,
  Play,
  Pulse,
  ShieldCheck,
  TerminalWindow,
  Warning,
  X,
} from '@phosphor-icons/react';
import {
  decideApproval,
  getDemo,
  startRun,
  subscribeToRun,
} from './api';
import type {
  ActivityItem,
  LabSnapshot,
  MetricsSnapshot,
  RunSnapshot,
  RunState,
} from '../shared/types';

const DEFAULT_MESSAGE =
  'Investigate the checkout incident and fix it. Before proposing or attempting remediation, you must run the required read-only Python diagnostic in TrueForge Code Mode and report its computed finding.';
const WORKFLOW_STAGES: Array<{ state: RunState; short: string }> = [
  { state: 'INVESTIGATING', short: 'Investigate' },
  { state: 'ANALYZING', short: 'Analyze' },
  { state: 'SANDBOX_RUNNING', short: 'Sandbox' },
  { state: 'ROOT_CAUSE_FOUND', short: 'Root cause' },
  { state: 'AWAITING_APPROVAL', short: 'Approval' },
  { state: 'REMEDIATING', short: 'Remediate' },
  { state: 'VERIFYING', short: 'Verify' },
  { state: 'RESOLVED', short: 'Resolved' },
];

export default function App() {
  const [demo, setDemo] = useState<LabSnapshot | null>(null);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void getDemo()
      .then(setDemo)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'The incident lab is unavailable.'))
      .finally(() => setLoading(false));
    return () => unsubscribeRef.current?.();
  }, []);

  async function handleStart() {
    if (!message.trim() || starting) return;
    setStarting(true);
    setError(null);
    unsubscribeRef.current?.();
    try {
      const created = await startRun(message.trim());
      setRun(created);
      unsubscribeRef.current = subscribeToRun(
        created.id,
        (snapshot) => {
          setRun(snapshot);
          if (snapshot.state === 'RESOLVED' || snapshot.state === 'REJECTED' || snapshot.state === 'FAILED') {
            setStarting(false);
          }
        },
        () => setError('The live agent stream disconnected. Refresh the run to inspect its saved state.'),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Aegis could not start the run.');
    } finally {
      setStarting(false);
    }
  }

  async function handleApproval(decision: 'allow' | 'deny') {
    if (!run?.approval || approvalBusy) return;
    setApprovalBusy(true);
    setError(null);
    try {
      const updated = await decideApproval(run.id, decision);
      setRun(updated);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Approval could not be submitted.');
    } finally {
      setApprovalBusy(false);
    }
  }

  const incident = run?.incident ?? demo?.incident;
  const metrics = run?.metrics ?? demo?.metrics;
  const activity = run?.activity ?? [];
  const activeState = run?.state ?? 'IDLE';

  if (loading) return <LoadingScreen />;
  if (!incident || !metrics) return <FailureScreen message={error ?? 'The incident lab did not return a usable snapshot.'} />;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><ShieldCheck size={21} weight="bold" /></div>
          <div>
            <p className="brand-name">AEGIS</p>
            <p className="brand-subtitle">incident commander</p>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="live-indicator"><span className="live-dot" /> Demo environment</span>
          <span className="topbar-divider" />
          <span className="harness-status"><Pulse size={15} weight="bold" /> TrueForge harness</span>
        </div>
      </header>

      <div className="page-frame">
        <section className="intro-row">
          <div>
            <p className="kicker">Production operations / checkout-api</p>
            <h1>One incident. <em>Evidence first.</em></h1>
            <p className="intro-copy">Aegis investigates with real tools, runs read-only diagnostics in a TrueForge sandbox, and stops before changing system state.</p>
          </div>
          <div className="run-context">
            <span className="context-label">Agent session</span>
            <span className="context-value">{run?.sessionId ? `…${run.sessionId.slice(-8)}` : 'Not started'}</span>
          </div>
        </section>

        <section className="incident-grid" aria-label="Incident overview">
          <article className={`incident-signal ${incident.status === 'resolved' ? 'is-resolved' : ''}`}>
            <div className="signal-topline">
              <span className="severity-tag"><span className="severity-dot" /> {incident.severity}</span>
              <span className="incident-id">{incident.id}</span>
              <span className={`status-tag ${incident.status}`}>{incident.status === 'resolved' ? 'Resolved' : 'Active incident'}</span>
            </div>
            <div className="signal-body">
              <div>
                <p className="eyebrow">{incident.service}</p>
                <h2>{incident.title}</h2>
                <p className="incident-description">{incident.description}</p>
              </div>
              <div className="error-rate-block">
                <span className="metric-label">Error rate</span>
                <strong>{metrics.errorRate.toFixed(1)}<small>%</small></strong>
                <span className="normal-label">Normal &lt; {metrics.normalErrorRate}%</span>
              </div>
            </div>
            <Sparkline metrics={metrics} />
            <div className="signal-footer">
              <span>Current incident telemetry</span>
              <span className="metric-inline">p95 {metrics.p95LatencyMs.toLocaleString()} ms <span className="footer-separator">/</span> success {metrics.checkoutSuccessRate.toFixed(1)}%</span>
            </div>
          </article>

          <section className="command-panel" aria-label="Command Aegis">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Command input</p>
                <h2>Give Aegis the incident.</h2>
              </div>
              <TerminalWindow size={22} weight="duotone" />
            </div>
            <label className="sr-only" htmlFor="command">Incident command</label>
            <textarea id="command" value={message} onChange={(event) => setMessage(event.target.value)} disabled={Boolean(run && !isTerminal(run.state))} rows={3} />
            <div className="command-footer">
              <span><LockKey size={14} /> Analysis is read-only until approval</span>
              <button className="primary-button" onClick={() => void handleStart()} disabled={!message.trim() || starting || Boolean(run && !isTerminal(run.state))}>
                {starting ? <ArrowClockwise className="spin" size={17} /> : <Play size={17} weight="fill" />}
                {starting ? 'Starting' : run && !isTerminal(run.state) ? 'Agent running' : 'Start investigation'}
              </button>
            </div>
          </section>
        </section>

        <section className="workflow-panel" aria-label="Agent state">
          <div className="workflow-header">
            <div>
              <p className="eyebrow">Execution state</p>
              <h2>{run?.stateLabel ?? 'Ready for command'}</h2>
            </div>
            <div className={`state-badge ${activeState.toLowerCase()}`}><span className="state-pulse" /> {activeState === 'IDLE' ? 'Awaiting command' : activeState}</div>
          </div>
          <div className="state-rail">
            {WORKFLOW_STAGES.map((stage, index) => {
              const stageStatus = stageStatusFor(stage.state, activeState);
              return (
                <div className={`rail-stage ${stageStatus}`} key={stage.state}>
                  <div className="rail-node">{stageStatus === 'complete' ? <Check size={13} weight="bold" /> : index + 1}</div>
                  <span>{stage.short}</span>
                  {index < WORKFLOW_STAGES.length - 1 && <div className="rail-line" />}
                </div>
              );
            })}
          </div>
        </section>

        <section className="lower-grid">
          <ActivityTimeline items={activity} />
          <aside className="evidence-column">
            <EvidenceCard finding={run?.rootCause} />
            <SandboxCard items={activity} />
            {run?.approval ? <ApprovalCard request={run.approval} busy={approvalBusy} onDecision={handleApproval} /> : <GuardrailCard state={activeState} />}
          </aside>
        </section>

        {run?.finalMessage && <section className="commander-note"><div className="note-icon"><ShieldCheck size={18} weight="bold" /></div><div><p className="eyebrow">Commander report</p><p>{run.finalMessage}</p></div></section>}
        {error && <div className="error-banner" role="alert"><Warning size={17} weight="fill" /><span>{error}</span></div>}
        {run && isTerminal(run.state) && <div className="run-again-row"><span>{run.state === 'RESOLVED' ? 'The incident lab is recovered. Run the scenario again for another pass.' : run.state === 'REJECTED' ? 'The proposed rollback was not executed. Run again when you are ready.' : 'The run stopped without claiming success.'}</span><button className="secondary-button" onClick={() => { setRun(null); setError(null); }}><ArrowClockwise size={16} /> Run again</button></div>}

        <footer className="page-footer"><span>Aegis / controlled incident lab</span><span><GitBranch size={14} /> TrueForge + MCP + sandbox</span></footer>
      </div>
    </main>
  );
}

function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  return (
    <section className="timeline-panel" aria-label="Agent activity">
      <div className="section-heading"><div><p className="eyebrow">Trace</p><h2>Agent activity</h2></div><span className="trace-count">{items.length.toString().padStart(2, '0')} events</span></div>
      {items.length === 0 ? <div className="empty-trace"><ActivityIcon size={25} /><p>Issue a command to see TrueForge work.</p><span>Every tool call and checkpoint will appear here.</span></div> : <div className="timeline-list">{items.map((item) => <TimelineItem item={item} key={item.id} />)}</div>}
    </section>
  );
}

function TimelineItem({ item }: { item: ActivityItem }) {
  const Icon = item.kind === 'sandbox' ? TerminalWindow : item.kind === 'approval' ? LockKey : item.kind === 'error' ? Warning : item.status === 'complete' ? CheckCircle : ActivityIcon;
  return <article className={`timeline-item ${item.status} ${item.kind}`}><div className="timeline-icon"><Icon size={16} weight={item.status === 'complete' ? 'fill' : 'bold'} /></div><div className="timeline-content"><div className="timeline-title-row"><h3>{item.title}</h3><time>{formatTime(item.at)}</time></div>{item.detail && <p>{item.detail}</p>}{item.code && <pre className="inline-code"><code>{item.code}</code></pre>}</div></article>;
}

function EvidenceCard({ finding }: { finding: RunSnapshot['rootCause'] }) {
  return <section className={`evidence-card ${finding ? 'has-finding' : ''}`}><div className="section-heading compact"><div><p className="eyebrow">Finding</p><h2>Root cause</h2></div><Warning size={19} weight="duotone" /></div>{finding ? <><h3>{finding.title}</h3><p className="finding-detail">{finding.detail}</p><ul className="evidence-list">{finding.evidence.map((line) => <li key={line}><CheckCircle size={15} weight="fill" />{line}</li>)}</ul></> : <div className="pending-evidence"><span className="pending-line" /><p>Waiting for the agent to correlate telemetry, logs, deployment history, and sandbox output.</p></div>}</section>;
}

function SandboxCard({ items }: { items: ActivityItem[] }) {
  const sandboxItems = items.filter((item) => item.kind === 'sandbox');
  const latest = sandboxItems[sandboxItems.length - 1];
  return <section className="sandbox-card"><div className="sandbox-top"><div className="sandbox-label"><TerminalWindow size={17} weight="bold" /><span>TrueForge sandbox</span></div><span className={`sandbox-state ${latest?.status === 'error' ? 'error' : latest ? 'complete' : ''}`}>{latest?.status === 'error' ? 'Failed' : latest ? 'Observed' : 'Not run'}</span></div><p className="sandbox-copy">Read-only diagnostic execution. No remediation tools or credentials enter this environment.</p>{latest?.detail && <div className="sandbox-result"><CheckCircle size={15} weight="fill" /><span>{latest.detail}</span></div>}{latest?.code && <pre className="sandbox-code"><code>{latest.code}</code></pre>} {!latest && <div className="sandbox-placeholder"><span>$</span><span>awaiting diagnostic script...</span></div>}</section>;
}

function ApprovalCard({ request, busy, onDecision }: { request: NonNullable<RunSnapshot['approval']>; busy: boolean; onDecision: (decision: 'allow' | 'deny') => Promise<void> }) {
  return <section className="approval-card" aria-live="assertive"><div className="approval-header"><div className="approval-alert"><Warning size={20} weight="fill" /><span>Human approval required</span></div><span className="approval-lock"><LockKey size={14} /> paused</span></div><h2>Rollback deployment <code>{request.deploymentId}</code>?</h2><p className="approval-reason">{request.reason}</p><dl className="approval-facts"><div><dt>Expected consequence</dt><dd>{request.expectedConsequence}</dd></div><div><dt>Reversible</dt><dd>{request.reversible ? 'Yes, restore the prior deployment' : 'No'}</dd></div></dl><div className="approval-actions"><button className="deny-button" onClick={() => void onDecision('deny')} disabled={busy}><X size={16} /> Reject</button><button className="approve-button" onClick={() => void onDecision('allow')} disabled={busy}>{busy ? <ArrowClockwise className="spin" size={16} /> : <Check size={16} weight="bold" />} {busy ? 'Sending' : 'Approve rollback'}</button></div><p className="approval-footnote">The remediation tool will not execute unless you approve.</p></section>;
}

function GuardrailCard({ state }: { state: RunState }) {
  const resolved = state === 'RESOLVED';
  return <section className={`guardrail-card ${resolved ? 'resolved' : ''}`}><div className="guardrail-icon">{resolved ? <CheckCircle size={20} weight="fill" /> : <LockKey size={19} weight="bold" />}</div><div><p className="eyebrow">Safety boundary</p><h2>{resolved ? 'Recovery verified' : 'No action authorized'}</h2><p>{resolved ? 'Aegis verified the recovered error rate after the approved rollback.' : 'State-changing tools remain locked until TrueForge reports an explicit operator approval.'}</p></div></section>;
}

function Sparkline({ metrics }: { metrics: MetricsSnapshot }) {
  const values = metrics.series.map((point) => point.errorRate);
  const max = Math.max(...values, metrics.normalErrorRate * 2, 1);
  const min = Math.min(...values, 0);
  const width = 620;
  const height = 88;
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * width},${height - ((value - min) / Math.max(max - min, 1)) * (height - 12) - 6}`).join(' ');
  const thresholdY = height - ((metrics.normalErrorRate - min) / Math.max(max - min, 1)) * (height - 12) - 6;
  return <div className="sparkline-wrap" aria-label={`Error rate trend, current ${metrics.errorRate}%`}><svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"><line x1="0" x2={width} y1={thresholdY} y2={thresholdY} className="threshold-line" /><polyline points={points} className={`sparkline-line ${metrics.recovered ? 'recovered' : ''}`} /><circle cx={points.split(' ').at(-1)?.split(',')[0]} cy={points.split(' ').at(-1)?.split(',')[1]} r="4" className="sparkline-dot" /></svg><div className="sparkline-labels"><span>{metrics.series[0]?.at}</span><span>normal threshold</span><span>{metrics.series.at(-1)?.at}</span></div></div>;
}

function stageStatusFor(stage: RunState, active: RunState): 'complete' | 'current' | 'upcoming' | 'blocked' {
  if (active === 'FAILED' || active === 'CANCELLED' || active === 'REJECTED') return stage === active ? 'current' : 'blocked';
  if (stage === active) return 'current';
  const stageIndex = WORKFLOW_STAGES.findIndex((item) => item.state === stage);
  const activeIndex = WORKFLOW_STAGES.findIndex((item) => item.state === active);
  if (active === 'IDLE') return 'upcoming';
  return stageIndex < activeIndex ? 'complete' : 'upcoming';
}

function isTerminal(state: RunState): boolean {
  return state === 'RESOLVED' || state === 'REJECTED' || state === 'FAILED' || state === 'CANCELLED';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function LoadingScreen() {
  return <main className="loading-screen"><div className="brand-mark"><ShieldCheck size={21} weight="bold" /></div><div className="loading-lines"><span /><span /><span /></div></main>;
}

function FailureScreen({ message }: { message: string }) {
  return <main className="failure-screen"><div className="failure-mark"><Warning size={22} weight="fill" /></div><p className="eyebrow">Aegis could not connect</p><h1>Incident data unavailable.</h1><p>{message}</p><span>Check the API process and reload the page.</span></main>;
}
