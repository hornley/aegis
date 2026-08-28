import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createIncidentLab } from '../domain/incidentLab.js';
import { createAegisApp } from './index.js';
import type { AgentRuntime } from './trueforge.js';

const fakeRuntime: AgentRuntime = {
  async createSession() {
    return { id: 'mcp-test-session' };
  },
  async streamTurn() {
    return (async function* emptyStream() {})();
  },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe('Aegis MCP endpoint', () => {
  it('publishes the incident tools and blocks direct rollback calls', async () => {
    const lab = createIncidentLab();
    const { app } = createAegisApp({ lab, runtime: fakeRuntime });
    const server = createServer(app);
    const url = await listen(server);
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: 'aegis-test-client', version: '0.1.0' });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual([
        'get_incident',
        'get_metrics',
        'get_logs',
        'get_recent_deployments',
        'rollback_deployment',
      ]);
      expect(listed.tools.find((tool) => tool.name === 'rollback_deployment')?.annotations?.destructiveHint).toBe(true);

      const metrics = await client.callTool({ name: 'get_metrics', arguments: { incident_id: 'INC-1042' } });
      expect(metrics.isError).not.toBe(true);
      expect(metrics).toMatchObject({ content: [{ type: 'text' }] });

      const rollback = await client.callTool({
        name: 'rollback_deployment',
        arguments: { deployment_id: '8f31a2', reason: 'Direct calls must not bypass approval.' },
      });
      expect(rollback.isError).toBe(true);
      expect(lab.getMetrics('INC-1042').recovered).toBe(false);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
