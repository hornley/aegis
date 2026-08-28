import { describe, expect, it } from 'vitest';
import { buildAgentSpec } from './trueforge.js';

describe('Aegis TrueForge agent spec', () => {
  it('keeps sandbox analysis enabled and rollback approval-gated', () => {
    const spec = buildAgentSpec({
      baseUrl: 'http://localhost:8790',
      model: 'openai/test-model',
      mcpServerName: 'aegis-incident-lab',
    });

    expect(spec.config).toMatchObject({
      sandbox: { enabled: true, fileDownloads: false },
      dynamicSubAgents: { enabled: false },
      iterationLimit: 30,
    });
    expect(spec.mcpServers?.[0]).toMatchObject({
      name: 'aegis-incident-lab',
      enableTools: [
        'get_incident',
        'get_metrics',
        'get_logs',
        'get_recent_deployments',
        'rollback_deployment',
      ],
      requireApprovalForTools: ['rollback_deployment'],
    });
  });
});
