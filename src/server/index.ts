import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { createIncidentLab, type IncidentLab } from '../domain/incidentLab.js';
import { attachIncidentMcpRoutes } from '../mcp/server.js';
import type { AgentRuntime } from './trueforge.js';
import { createTrueForgeRuntime, type TrueForgeSettings } from './trueforge.js';
import { RunManager } from './runManager.js';

const DEFAULT_MESSAGE =
  'Investigate the checkout incident and fix it. Before proposing or attempting remediation, you must run the required read-only Python diagnostic in TrueForge Code Mode and report its computed finding.';

export interface AppDependencies {
  lab?: IncidentLab;
  runtime?: AgentRuntime;
  trueforgeSettings?: TrueForgeSettings;
}

export interface AegisApp {
  app: Express;
  lab: IncidentLab;
  manager: RunManager;
}

export function createAegisApp(dependencies: AppDependencies = {}): AegisApp {
  const app = express();
  const lab = dependencies.lab ?? createIncidentLab({ fixtureDir: process.env.AEGIS_DEMO_DIR });
  const settings = dependencies.trueforgeSettings ?? loadTrueForgeSettings();
  const runtime = dependencies.runtime ?? createTrueForgeRuntime(settings);
  const manager = new RunManager(lab, runtime);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  attachIncidentMcpRoutes(app, lab);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'aegis',
      trueforge: {
        baseUrl: settings.baseUrl,
        model: settings.model,
        mcpServerName: settings.mcpServerName,
        sandboxRequested: true,
      },
    });
  });

  app.get('/api/demo', (_req, res) => {
    res.json(lab.getSnapshot());
  });

  app.post('/api/runs', (req, res) => {
    const parsed = z
      .object({ message: z.string().trim().min(1).max(2_000).default(DEFAULT_MESSAGE) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Message must be between 1 and 2,000 characters.' });
      return;
    }
    res.status(202).json(manager.start(parsed.data.message));
  });

  app.get('/api/runs/:runId', (req, res) => {
    const runId = String(req.params.runId);
    const snapshot = manager.get(runId);
    if (!snapshot) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    res.json(snapshot);
  });

  app.get('/api/runs/:runId/events', (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    if (!manager.get(runId)) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    const unsubscribe = manager.subscribe(runId, (snapshot) => {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/api/runs/:runId/approval', async (req, res) => {
    const parsed = z.object({ decision: z.enum(['allow', 'deny']) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Decision must be allow or deny.' });
      return;
    }
    try {
      res.status(202).json(await manager.decide(String(req.params.runId), parsed.data.decision));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Approval could not be processed.';
      res.status(409).json({ error: message });
    }
  });

  app.post('/api/demo/reset', (_req, res) => {
    lab.reset();
    res.json(lab.getSnapshot());
  });

  const webRoot = resolve(process.cwd(), 'dist/web');
  app.use(express.static(webRoot));
  app.get(/^(?!\/api(?:\/|$)|\/mcp(?:\/|$)).*/, (_req, res) => {
    res.sendFile(resolve(webRoot, 'index.html'));
  });

  return { app, lab, manager };
}

function loadTrueForgeSettings(): TrueForgeSettings {
  return {
    baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
    token: process.env.TRUEFORGE_TOKEN || undefined,
    model: process.env.TRUEFORGE_MODEL ?? 'openai/gpt-4o-mini',
    mcpServerName: process.env.TRUEFORGE_MCP_SERVER_NAME ?? 'aegis-incident-lab',
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 3000);
  const { app } = createAegisApp();
  app.listen(port, host, () => {
    console.log(`Aegis is listening on http://${host}:${port}`);
    console.log(`Incident MCP endpoint: http://localhost:${port}/mcp`);
  });
}

export { DEFAULT_MESSAGE };
