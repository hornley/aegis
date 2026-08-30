import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface TrueForgeSettings {
  baseUrl: string;
  token?: string;
  model: string;
  mcpServerName: string;
}

export const AEGIS_AGENT_INSTRUCTIONS = `
You are Aegis, an AI incident commander for the checkout-api service. One incident: INC-1042, checkout failures, error rate 18.4% (normal < 2%). Failed deployment 8f31a2. Known-good deployment 7d20c1.

STRICT STEP ORDER. Follow exactly. Do not skip steps. Do not invent results.

STEP 1 — MANDATORY sandbox diagnostic (do this FIRST, before any other tool call):
Use the TrueForge sandbox exec tool to run this exact command, then the three following commands, one at a time:
  python3 /opt/tf/mcp-client/mcp_client.py call-tool aegis-incident-lab get_metrics '{"incident_id":"INC-1042"}'
  python3 /opt/tf/mcp-client/mcp_client.py call-tool aegis-incident-lab get_logs '{"incident_id":"INC-1042","limit":50}'
  python3 /opt/tf/mcp-client/mcp_client.py call-tool aegis-incident-lab get_recent_deployments '{"service":"checkout-api"}'
Wait for each exec result before the next. If a command errors, re-run it exactly as written. Never claim a sandbox result unless the exec tool returned real output. Never call rollback_deployment before finishing STEP 1.

STEP 2 — Read context (may use MCP get_incident and get_metrics normally).

STEP 3 — Root cause and proposal:
State the root cause as a ROOT CAUSE finding. Propose rollback of deployment 8f31a2 ONLY. Never propose 7d20c1. Then call rollback_deployment with deployment_id exactly "8f31a2" and an evidence-based reason. TrueForge will pause for human approval — wait for it.

STEP 4 — After approval, re-read get_metrics and verify recovered is true and errorRate is below 2. Only then say VERIFIED RECOVERY.

If the operator denies, state clearly that no rollback executed and stop.

Never bypass approval. Never call rollback for 7d20c1. Never describe the rollback as done before the tool returns success. Never claim a metric or sandbox result you did not actually receive from a tool. Work strictly from real tool output.
`.trim();

export interface AgentRuntime {
  createSession(): Promise<{ id: string }>;
  streamTurn(sessionId: string, input: TrueForgeApi.TurnInputItem[]): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>>;
}

export function buildAgentSpec(settings: TrueForgeSettings): TrueForgeApi.AgentSpec {
  return {
    model: {
      name: settings.model,
      params: {
        temperature: 0.1,
        maxTokens: 4096,
      },
    },
    instructions: AEGIS_AGENT_INSTRUCTIONS,
    mcpServers: [
      {
        name: settings.mcpServerName,
        enableTools: [
          'get_incident',
          'get_metrics',
          'get_logs',
          'get_recent_deployments',
          'rollback_deployment',
        ],
        requireApprovalForTools: ['rollback_deployment'],
        preloadTools: ['get_incident', 'get_metrics', 'get_logs', 'get_recent_deployments', 'rollback_deployment'],
      },
    ],
    config: {
      sandbox: { enabled: true, fileDownloads: false },
      askUserQuestions: { enabled: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      iterationLimit: 40,
    },
  };
}

export class TrueForgeRuntime implements AgentRuntime {
  private readonly client: TrueForge;
  private readonly spec: TrueForgeApi.AgentSpec;

  constructor(settings: TrueForgeSettings) {
    this.client = new TrueForge({
      baseUrl: settings.baseUrl,
      token: settings.token,
      timeoutInSeconds: 600,
      maxRetries: 1,
      stream: {
        reconnectionEnabled: true,
        maxReconnectionAttempts: 3,
      },
    });
    this.spec = buildAgentSpec(settings);
  }

  async createSession(): Promise<{ id: string }> {
    const response = await this.client.sessions.create({ agent: { spec: this.spec } });
    return { id: response.data.id };
  }

  async streamTurn(sessionId: string, input: TrueForgeApi.TurnInputItem[]): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>> {
    return this.client.sessions.createTurnStream(sessionId, { input });
  }
}

export function createTrueForgeRuntime(settings: TrueForgeSettings): TrueForgeRuntime {
  return new TrueForgeRuntime(settings);
}
