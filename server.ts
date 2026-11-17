import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { decodeConfigBase64Url } from './src/core/config.ts';
import {
  buildManifest,
  clearPipelineResponseCache,
  runStreamPipeline,
} from './src/core/pipeline.ts';
import {
  fetchProfileConfigFromFirestore,
  globalProfileCache,
  isValidProfileId,
  type FirebaseClientConfig,
} from './src/core/profileStore.ts';
import { probeAddonManifest, probeManyAddonManifests } from './src/core/probe.ts';
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

function loadFirebaseConfig(): FirebaseClientConfig | null {
  try {
    const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<FirebaseClientConfig>;
    if (raw.projectId && raw.apiKey && raw.firestoreDatabaseId) {
      return {
        projectId: raw.projectId,
        apiKey: raw.apiKey,
        firestoreDatabaseId: raw.firestoreDatabaseId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

const firebaseClientConfig = loadFirebaseConfig();

function setStremioJsonHeaders(res: Response): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');
}

async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(compression());

  // CORS obrigatório para Stremio, Nuvio e chamadas externas
  app.use(
    cors({
      origin: '*',
      allowedHeaders: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // Rotas Permanentes por Perfil Salvo na Nuvem (/p/:profileId/*)
  app.get('/p/:profileId/manifest.json', async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const profileId = typeof req.params.profileId === 'string' ? req.params.profileId.trim() : '';
    if (isValidProfileId(profileId)) {
      const cfg = await fetchProfileConfigFromFirestore(profileId, firebaseClientConfig);
      if (cfg) {
        globalAddonWarmer.warmAddons(cfg.addons);
      }
    }
    res.status(200).json(buildManifest());
  });

  const handleProfileStreamRequest = async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const profileId = typeof req.params.profileId === 'string' ? req.params.profileId.trim() : '';
    const type = typeof req.params.type === 'string' ? req.params.type : '';
    const rawId = (typeof req.params.id === 'string' ? req.params.id : '').replace(/\.json$/i, '');

    if (!isValidProfileId(profileId) || !type || !rawId) {
      res.status(200).json({ streams: [] });
      return;
    }

    try {
      const cfg = await fetchProfileConfigFromFirestore(profileId, firebaseClientConfig);
      if (!cfg) {
        res.status(200).json({ streams: [] });
        return;
      }
      const result = await runStreamPipeline(cfg, type, rawId);
      res.status(200).json({ streams: result.streams });
    } catch (error) {
      console.error('[StreamHub Lite] Profile pipeline error:', error);
      res.status(200).json({ streams: [] });
    }
  };

  app.get('/p/:profileId/stream/:type/:id.json', handleProfileStreamRequest);
  app.get('/p/:profileId/stream/:type/:id', handleProfileStreamRequest);

  app.get('/p/:profileId/debug-stream/:type/:id.json', async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const profileId = typeof req.params.profileId === 'string' ? req.params.profileId.trim() : '';
    const type = typeof req.params.type === 'string' ? req.params.type : 'movie';
    const rawId = (typeof req.params.id === 'string' ? req.params.id : '').replace(/\.json$/i, '');

    const startedAt = Date.now();
    if (!isValidProfileId(profileId)) {
      res.status(400).json({ durationMs: 0, error: 'ID de perfil inválido.' });
      return;
    }

    try {
      const cfg = await fetchProfileConfigFromFirestore(profileId, firebaseClientConfig);
      if (!cfg) {
        res.status(404).json({ durationMs: Date.now() - startedAt, error: 'Perfil salvo não encontrado.' });
        return;
      }
      const result = await runStreamPipeline(cfg, type, rawId);
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
  });

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
    const force = req.query.force === '1' || req.query.force === 'true';
    if (!rawUrl.trim()) {
      res.status(400).json({ url: '', active: false, error: 'Parâmetro url é obrigatório.', latencyMs: 0 });
      return;
    }

    const result = await probeAddonManifest(rawUrl, 5000, force);
    res.json(result);
  });

  app.post('/api/probe-manifests', express.json({ limit: '64kb' }), async (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      urls?: unknown;
      force?: unknown;
    };
    const urls = Array.isArray(body.urls)
      ? body.urls.filter((u): u is string => typeof u === 'string')
      : [];
    const force = body.force === true;

    if (urls.length === 0) {
      res.json({ results: [] });
      return;
    }

    const results = await probeManyAddonManifests(urls, 5000, force);
    res.json({ results });
  });

  app.post('/api/profile-cache/invalidate', express.json({ limit: '8kb' }), (req: Request, res: Response) => {
    setStremioJsonHeaders(res);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      profileId?: unknown;
    };
    if (typeof body.profileId === 'string' && isValidProfileId(body.profileId)) {
      globalProfileCache.invalidate(body.profileId);
      clearPipelineResponseCache();
    }
    res.json({ ok: true });
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

  // Garante que nenhuma requisição .json caia no HTML do Vite/SPA (preserva imports JS de Vite como ?import)
  app.get(/\.json$/i, (req: Request, res: Response, next: NextFunction) => {
    if ('import' in req.query) {
      next();
      return;
    }
    setStremioJsonHeaders(res);
    res.status(404).json({ error: 'Rota JSON não encontrada.' });
  });

  // =========================================================================
  // Interface Web (/configure) — Vite em dev, dist/ estático em produção
  // =========================================================================

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'custom',
    });

    app.get('/@vite/client', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(`
const sheetsMap = new Map();
const linkSheetsMap = new Map();
if ("document" in globalThis) {
  document.querySelectorAll("style[data-vite-dev-id]").forEach((el) => {
    sheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
  document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id]').forEach((el) => {
    linkSheetsMap.set(el.getAttribute("data-vite-dev-id"), el);
  });
}
let lastInsertedStyle;
function updateStyle(id, content) {
  if (linkSheetsMap.has(id)) return;
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-vite-dev-id", id);
    style.textContent = content;
    if (!lastInsertedStyle) {
      document.head.appendChild(style);
      setTimeout(() => { lastInsertedStyle = undefined; }, 0);
    } else {
      lastInsertedStyle.insertAdjacentElement("afterend", style);
    }
    lastInsertedStyle = style;
  } else if (style.textContent !== content) {
    style.textContent = content;
  }
  sheetsMap.set(id, style);
}
function removeStyle(id) {
  if (linkSheetsMap.has(id)) {
    document.querySelectorAll('link[rel="stylesheet"][data-vite-dev-id="' + CSS.escape(id) + '"]').forEach((el) => el.remove());
    linkSheetsMap.delete(id);
  }
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
function createHotContext() {
  return {
    data: {},
    accept() {},
    dispose() {},
    prune() {},
    invalidate() {},
    decline() {},
    on() {},
    off() {},
    send() {},
  };
}
function injectQuery(url, queryToInject) {
  if (url[0] !== "." && url[0] !== "/") return url;
  const pathname = url.replace(/[?#].*$/, "");
  const { search, hash } = new URL(url, "http://vite.dev");
  return pathname + "?" + queryToInject + (search ? "&" + search.slice(1) : "") + (hash || "");
}
const BaseElement = globalThis.HTMLElement || class {};
class ErrorOverlay extends BaseElement {}
export { ErrorOverlay, createHotContext, injectQuery, removeStyle, updateStyle };
`);
    });

    app.use(vite.middlewares);

    app.get(['/', '/configure', '/p/:profileId/configure', '/:config/configure'], async (req: Request, res: Response, next: NextFunction) => {
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

    app.get(['/', '/configure', '/p/:profileId/configure', '/:config/configure'], (_req: Request, res: Response) => {
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
