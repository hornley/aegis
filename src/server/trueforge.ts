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
5. You MUST use the TrueForge sandbox Code Mode for a read-only diagnostic before identifying a root cause or proposing remediation. In the sandbox, call the MCP tools with the mcp_client.py CLI using this exact positional syntax:
   - mcp_client.py call-tool aegis-incident-lab get_incident '{"incident_id":"INC-1042"}'
   - mcp_client.py call-tool aegis-incident-lab get_metrics '{"incident_id":"INC-1042"}'
   - mcp_client.py call-tool aegis-incident-lab get_logs '{"incident_id":"INC-1042","limit":50}'
   - mcp_client.py call-tool aegis-incident-lab get_recent_deployments '{"service":"checkout-api"}'
   The third positional argument is a JSON object string with single quotes around it. The incident_id value is exactly the incident ID string (e.g. INC-1042), NEVER the MCP server name "aegis-incident-lab" and NEVER a deployment ID. Do NOT call get_logs or any MCP tool as a bare shell command, do NOT use --input or -i flags, and do NOT rename the arguments. If a command fails, correct the command and retry. Count the returned records and error codes, correlate the error spike with the deployment timestamp, and print the computed findings. Do not invent a sandbox result or perform arithmetic in prose. If Code Mode is unavailable or the script fails, stop and report that the required diagnostic could not run.
6. Use the evidence, including the printed sandbox finding, to identify the most likely root cause and propose one rollback. Include the deployment ID, evidence, expected consequence, and whether the action is reversible. The rollback deployment_id MUST exactly equal failedDeploymentId from get_incident. In the INC-1042 scenario, failedDeploymentId is "8f31a2" and the known-good deployment is "7d20c1" — the rollback target is ALWAYS 8f31a2, NEVER 7d20c1. Rolling back 7d20c1 is wrong and will be rejected. Only deployment 8f31a2 is the active incident deployment.
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
