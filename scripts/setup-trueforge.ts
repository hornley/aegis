import 'dotenv/config';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const baseUrl = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const name = process.env.TRUEFORGE_MCP_SERVER_NAME ?? 'aegis-incident-lab';
const url = process.env.TRUEFORGE_MCP_URL ?? `http://localhost:${process.env.PORT ?? '3000'}/mcp`;

const client = new TrueForge({
  baseUrl,
  token: process.env.TRUEFORGE_TOKEN || undefined,
  timeoutInSeconds: 30,
  maxRetries: 1,
});

try {
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name,
      type: 'remote',
      url,
      description: 'A bounded, fixture-backed incident lab for checkout telemetry and an approval-gated rollback.',
    },
  });
  console.log(`Configured TrueForge MCP connector "${name}" at ${url}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown TrueForge configuration error.';
  console.error(`Could not configure the TrueForge MCP connector: ${message}`);
  process.exitCode = 1;
}
