import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { IncidentLab, IncidentLabError } from '../domain/incidentLab.js';

interface McpConnection {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof IncidentLabError ? error.message : 'The incident lab returned an unexpected error.';
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  };
}

export function createIncidentMcpServer(lab: IncidentLab): McpServer {
  const server = new McpServer({
    name: 'aegis-incident-lab',
    version: '0.1.0',
  });

  server.registerTool(
    'get_incident',
    {
      title: 'Get incident',
      description: 'Read the current checkout incident status, severity, service, and failed deployment.',
      inputSchema: { incident_id: z.string().describe('Incident ID, for example INC-1042') },
      annotations: readOnlyAnnotations,
    },
    ({ incident_id }) => {
      try {
        return jsonResult(lab.getIncident(incident_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_metrics',
    {
      title: 'Get checkout metrics',
      description: 'Read current and recent checkout error-rate and latency metrics for an incident.',
      inputSchema: { incident_id: z.string().describe('Incident ID, for example INC-1042') },
      annotations: readOnlyAnnotations,
    },
    ({ incident_id }) => {
      try {
        return jsonResult(lab.getMetrics(incident_id));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Get checkout logs',
      description: 'Read bounded, read-only application logs associated with an incident.',
      inputSchema: {
        incident_id: z.string().describe('Incident ID, for example INC-1042'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum records to return'),
      },
      annotations: readOnlyAnnotations,
    },
    ({ incident_id, limit }) => {
      try {
        return jsonResult({ incidentId: incident_id, logs: lab.getLogs(incident_id, limit) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_recent_deployments',
    {
      title: 'Get recent deployments',
      description: 'Read recent checkout deployments with commit, change summary, and active status.',
      inputSchema: {
        service: z.string().describe('Service name, for example checkout-api'),
      },
      annotations: readOnlyAnnotations,
    },
    ({ service }) => {
      try {
        return jsonResult({ service, deployments: lab.getRecentDeployments(service, 10) });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'rollback_deployment',
    {
      title: 'Rollback deployment',
      description:
        'State-changing action. Restore the known-good checkout deployment. The Aegis app grants a short-lived approval token only after a human allows this tool through TrueForge.',
      inputSchema: {
        deployment_id: z.string().describe('Deployment to roll back, for example 8f31a2'),
        reason: z.string().min(10).describe('Evidence-based reason for the rollback'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ deployment_id, reason }) => {
      try {
        return jsonResult(lab.rollbackDeployment(deployment_id, reason));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function attachIncidentMcpRoutes(app: Express, lab: IncidentLab): void {
  const connections = new Map<string, McpConnection>();

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const requestedSessionId = req.header('mcp-session-id');
      let connection = requestedSessionId ? connections.get(requestedSessionId) : undefined;

      if (!connection) {
        if (requestedSessionId) {
          res.status(404).json({ error: 'MCP session not found' });
          return;
        }

        const server = createIncidentMcpServer(lab);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => {
            connections.set(sessionId, { server, transport });
          },
          onsessionclosed: (sessionId) => {
            connections.delete(sessionId);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) connections.delete(transport.sessionId);
        };
        await server.connect(transport);
        connection = { server, transport };
      }

      await connection.transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : 'MCP request failed.';
        res.status(500).json({ error: message });
      }
    }
  });
}
