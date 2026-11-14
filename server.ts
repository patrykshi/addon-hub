import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { decodeConfigBase64Url } from './src/core/config.ts';
import { buildManifest, runStreamPipeline } from './src/core/pipeline.ts';
import { probeAddonManifest } from './src/core/probe.ts';
import { globalAddonWarmer } from './src/core/streamCache.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.resolve(__dirname, 'dist');
const isDevRunner =
  process.env.STREAMHUB_DEV === '1' ||
  process.env.npm_lifecycle_event === 'dev';
const IS_PROD =
  !isDevRunner &&
  (process.env.NODE_ENV === 'production' || existsSync(path.join(DIST_DIR, 'index.html')));

function setStremioJsonHeaders(res: Response): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
}

async function createServer() {
  const app = express();

  // CORS obrigatório para Stremio, Nuvio e chamadas externas
  app.use(
    cors({
      origin: '*',
      allowedHeaders: '*',
      methods: ['GET', 'OPTIONS'],
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // =========================================================================
  // PRIORIDADE ABSOLUTA: Rotas JSON do Stremio & Nuvio (antes de Vite/Static)
  // =========================================================================

  const resolveEffectiveConfigParam = (param: unknown): string | undefined => {
    if (typeof param === 'string' && param.trim()) {
      return param.trim();
    }
    const envDefault = process.env.DEFAULT_USER_CONFIG?.trim();
    return envDefault || undefined;
  };

  app.get(['/manifest.json', '/:config/manifest.json'], (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const effectiveConfig = resolveEffectiveConfigParam(req.params.config);
    if (effectiveConfig) {
      const config = decodeConfigBase64Url(effectiveConfig);
      globalAddonWarmer.warmAddons(config.addons);
    }
    res.status(200).json(buildManifest());
  });

  const handleStreamRequest = async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const effectiveConfig = resolveEffectiveConfigParam(req.params.config);
    const type = typeof req.params.type === 'string' ? req.params.type : '';
    const rawId = (typeof req.params.id === 'string' ? req.params.id : '').replace(/\.json$/i, '');

    if (!type || !rawId) {
      res.status(400).json({ streams: [], error: 'Parâmetros type e id são obrigatórios.' });
      return;
    }

    try {
      const config = decodeConfigBase64Url(effectiveConfig);
      const result = await runStreamPipeline(config, type, rawId);
      res.status(200).json({ streams: result.streams });
    } catch (error) {
      console.error('[StreamHub Lite] Pipeline error:', error);
      res.status(200).json({ streams: [] });
    }
  };

  app.get('/stream/:type/:id.json', handleStreamRequest);
  app.get('/:config/stream/:type/:id.json', handleStreamRequest);
  app.get('/stream/:type/:id', handleStreamRequest);
  app.get('/:config/stream/:type/:id', handleStreamRequest);

  app.get('/api/health', (_req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    res.json({ status: 'ok', service: 'streamhub-lite' });
  });

  app.get('/api/probe-manifest', async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl.trim()) {
      res.status(400).json({ url: '', active: false, error: 'Parâmetro url é obrigatório.', latencyMs: 0 });
      return;
    }

    const result = await probeAddonManifest(rawUrl, 5000);
    res.json(result);
  });

  app.get(
    ['/debug-stream/:type/:id.json', '/:config/debug-stream/:type/:id.json'],
    async (req: Request, res: Response) => {
      setStremioJsonHeaders(res);
      const effectiveConfig = resolveEffectiveConfigParam(req.params.config);
      const type = typeof req.params.type === 'string' ? req.params.type : 'movie';
      const rawId = (typeof req.params.id === 'string' ? req.params.id : '').replace(/\.json$/i, '');

      const startedAt = Date.now();
      try {
        const config = decodeConfigBase64Url(effectiveConfig);
        const result = await runStreamPipeline(config, type, rawId);
        res.json({
          durationMs: Date.now() - startedAt,
          ...result,
        });
      } catch (error) {
        res.status(500).json({
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : 'Erro desconhecido ao processar pipeline.',
        });
      }
    },
  );

  // Garante que nenhuma requisição .json caia no HTML do Vite/SPA
  app.get(/\.json$/i, (_req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    res.status(404).json({ error: 'Rota JSON não encontrada.' });
  });

  // =========================================================================
  // Interface Web (/configure) — Vite em dev, dist/ estático em produção
  // =========================================================================

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });

    app.use(vite.middlewares);

    app.get(['/', '/configure', '/:config/configure'], async (req: Request, res: Response, next: NextFunction) => {
      try {
        const templatePath = path.resolve(__dirname, 'index.html');
        const template = await fs.readFile(templatePath, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    app.use(express.static(DIST_DIR, { index: false }));

    app.get(['/', '/configure', '/:config/configure'], (_req: Request, res: Response) => {
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[StreamHub Lite] Servidor ativo em http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`);
  });
}

createServer().catch((err) => {
  console.error('[StreamHub Lite] Falha ao iniciar servidor:', err);
  process.exit(1);
});
