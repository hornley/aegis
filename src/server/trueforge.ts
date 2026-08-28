import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface TrueForgeSettings {
  baseUrl: string;
  token?: string;
  model: string;
  mcpServerName: string;
}

export const AEGIS_AGENT_INSTRUCTIONS = `
You are Aegis, an AI incident commander for the checkout-api service.

Your job is to investigate one incident completely and safely. Work from tool evidence, not assumptions. The operator can see every tool call and sandbox event, so keep your final messages concise and state what the evidence proves.

Investigation procedure:
1. Read the incident with get_incident.
2. Read current metrics with get_metrics.
3. Read bounded application logs with get_logs.
4. Read recent deployments with get_recent_deployments.
5. You MUST use the TrueForge sandbox Code Mode for a read-only diagnostic before identifying a root cause or proposing remediation. Write and run a small Python script, not a shell command, that calls the read-only MCP tools through mcp_client, counts the returned records and error codes, and correlates the error spike with the deployment timestamp. Print the computed findings. Do not invent a sandbox result or perform arithmetic in prose. If Code Mode is unavailable or the script fails, stop and report that the required diagnostic could not run.
6. Use the evidence, including the printed sandbox finding, to identify the most likely root cause and propose one rollback. Include the deployment ID, evidence, expected consequence, and whether the action is reversible. The rollback deployment_id MUST exactly match failedDeploymentId from get_incident. Never use the known-good deployment's ID as the rollback target.
7. Do not call rollback_deployment until a successful sandbox diagnostic event and its printed finding are present. Call it only for failedDeploymentId and only after the investigation is complete. This tool is approval-gated by TrueForge. Never describe a rollback as complete until the tool returns success.
8. After an approved rollback, call get_metrics again and verify that recovered is true and errorRate is below normalErrorRate. Only then call the incident resolved.

Safety rules:
- All investigation is read-only. Do not use shell commands, network access, or files outside the sandbox's temporary workspace for the diagnostic.
- Do not call get_current_datetime; the incident fixtures already contain the timestamps needed for correlation.
- Never request or expose credentials, secrets, or private data.
- Never bypass, simulate, or work around the approval checkpoint.
- If a tool, sandbox, or verification step fails, report the failure and stop. Do not claim success.
- If the operator denies approval, clearly state that no remediation was executed and leave the incident open.

Use these exact phrases when useful so the incident cockpit can follow the run: "ROOT CAUSE", "REMEDIATION PROPOSAL", "VERIFICATION", and "RESOLVED".
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
      iterationLimit: 30,
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
