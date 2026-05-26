import path from "node:path";
import os from "node:os";
import { readFile, unlink } from "node:fs/promises";
import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pino from "pino";

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = pino(
  process.env.NODE_ENV === "production"
    ? { level: "info" }
    : {
        level: "info",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      },
);

// ── Env vars ──────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT ?? "3000", 10);
const RENDER_SECRET    = process.env.REMOTION_RENDER_SECRET ?? "";
const SUPABASE_URL     = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const R2_ACCOUNT_ID    = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_KEY    = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET        = process.env.R2_BUCKET_NAME ?? "";
const R2_PUBLIC_URL    = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

// Render/Railway ont de vraies CPUs — on peut aller plus haut en prod.
// Pour les tests initiaux on reste à 720×1280 (configurable via env).
const MAX_WIDTH     = parseInt(process.env.REMOTION_MAX_WIDTH  ?? "720",  10);
const MAX_HEIGHT    = parseInt(process.env.REMOTION_MAX_HEIGHT ?? "1280", 10);
const MAX_SCENE_SEC = parseFloat(process.env.REMOTION_MAX_SCENE_SEC ?? "15");

const RENDER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const BUNDLE_TIMEOUT_MS =  2 * 60 * 1000; //  2 minutes

// ── Startup check ─────────────────────────────────────────────────────────────
const REQUIRED: Record<string, string | undefined> = {
  REMOTION_RENDER_SECRET:   process.env.REMOTION_RENDER_SECRET,
  SUPABASE_URL:             process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  R2_ACCOUNT_ID:            process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID:         process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY:     process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME:           process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL:            process.env.R2_PUBLIC_URL,
};
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  logger.warn({ missing }, "Variables d'env manquantes — certaines fonctions peuvent échouer");
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface Scene {
  asset_url:  string;
  asset_type: "image" | "video";
  duration:   number;
  text:       string;
  transition: string;
}

interface AiPlan {
  format?:      string;
  width?:       number;
  height?:      number;
  hook_text?:   string;
  cta_text?:    string;
  text_color?:  string;
  music_style?: string;
  scenes:       Scene[];
}

interface RenderBody {
  job_id:   string;
  user_id:  string;
  ai_plan:  AiPlan;
  format?:  string;
  width?:   number;
  height?:  number;
  [key: string]: unknown;
}

// ── S3 / Cloudflare R2 ────────────────────────────────────────────────────────
function makeS3(): S3Client {
  return new S3Client({
    region:   "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_KEY,
    },
  });
}

// ── Supabase PATCH video_jobs ─────────────────────────────────────────────────
async function updateVideoJob(
  job_id: string,
  patch:  Record<string, unknown>,
  log:    pino.Logger,
): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    log.error({ job_id }, "supabase: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquante");
    return;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/video_jobs?id=eq.${encodeURIComponent(job_id)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey:          SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        Prefer:         "return=minimal",
      },
      body: JSON.stringify(patch),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      log.error({ job_id, status: res.status, body: text, patch }, "supabase: PATCH échoué");
      return;
    }

    log.info({ job_id, patch }, "supabase: video_jobs mis à jour");
  } catch (err: unknown) {
    log.error({ job_id, err: String(err) }, "supabase: PATCH exception");
  }
}

// ── Bundle mutex ──────────────────────────────────────────────────────────────
// Un seul bundle() à la fois. Si warm-up en cours, le job attend.
// Rejet après BUNDLE_TIMEOUT_MS → PATCH Supabase failed.
let cachedBundleDir: string | null       = null;
let bundlePromise:   Promise<string> | null = null;
let chromeCached     = false;

function makeBundleTimeoutError(): Error {
  return Object.assign(
    new Error("Remotion bundle timeout"),
    { isBundleTimeout: true },
  );
}

function isBundleTimeoutErr(err: unknown): boolean {
  return (err as { isBundleTimeout?: boolean } | null)?.isBundleTimeout === true;
}

async function getBundleDir(log: pino.Logger): Promise<string> {
  if (cachedBundleDir) {
    log.info({ bundleDir: cachedBundleDir }, "bundle: cache HIT");
    return cachedBundleDir;
  }

  if (bundlePromise) {
    log.info("bundle: compilation en cours — attente mutex");
    const dir = await bundlePromise;
    log.info({ bundleDir: dir }, "bundle: cache HIT (via mutex)");
    return dir;
  }

  const { bundle } = await import("@remotion/bundler");

  // process.cwd() = /app en Docker, dossier du projet en local
  // remotion/Root.tsx est copié à la racine dans les deux cas
  const entryPoint = path.join(process.cwd(), "remotion", "Root.tsx");

  log.info({ entryPoint, cwd: process.cwd() }, "bundle: cache MISS — start compilation webpack");
  const t = Date.now();

  const timeout$ = new Promise<never>((_, reject) =>
    setTimeout(() => reject(makeBundleTimeoutError()), BUNDLE_TIMEOUT_MS),
  );

  bundlePromise = Promise.race([bundle({ entryPoint }), timeout$]).then(
    (dir) => {
      cachedBundleDir = dir;
      bundlePromise   = null;
      log.info({ duration_ms: Date.now() - t, bundleDir: dir }, "bundle: OK — compilé et mis en cache");
      return dir;
    },
    (err: unknown) => {
      bundlePromise = null;
      if (isBundleTimeoutErr(err)) {
        log.error({ duration_ms: Date.now() - t }, "bundle: timeout (2 min dépassées)");
      } else {
        log.error(
          { duration_ms: Date.now() - t, err: String(err), stack: err instanceof Error ? err.stack : undefined },
          "bundle: failed",
        );
      }
      throw err;
    },
  );

  return bundlePromise;
}

async function ensureBrowserCached(log: pino.Logger): Promise<void> {
  const { ensureBrowser } = await import("@remotion/renderer");
  const t = Date.now();

  if (chromeCached) {
    log.info("ensureBrowser: cache HIT");
    return;
  }

  log.info("ensureBrowser: start (peut télécharger Chrome Headless Shell si absent)");
  const status = await ensureBrowser({ chromeMode: "headless-shell" });
  chromeCached = true;

  const hit = status.type === "local-puppeteer-browser" || status.type === "user-defined-path";
  log.info(
    { status: status.type, cache: hit ? "HIT" : "MISS", duration_ms: Date.now() - t },
    hit ? "ensureBrowser: cache HIT — Chrome déjà présent" : "ensureBrowser: cache MISS — Chrome téléchargé",
  );
}

// ── Warm-up au démarrage ──────────────────────────────────────────────────────
async function warmupRemotion(): Promise<void> {
  const log = logger.child({ scope: "remotion-warmup" });
  log.info("warm-up: démarrage");
  const t0 = Date.now();

  try { await ensureBrowserCached(log); }
  catch (err) { log.error({ err: String(err) }, "warm-up: ensureBrowser échoué (non-fatal)"); }

  try { await getBundleDir(log); }
  catch (err) {
    if (isBundleTimeoutErr(err)) {
      log.error("warm-up: bundle timeout — sera réessayé au prochain rendu");
    } else {
      log.error({ err: String(err) }, "warm-up: bundle échoué (non-fatal)");
    }
  }

  log.info({ total_ms: Date.now() - t0 }, "warm-up: terminé");
}

// ── Validation des médias distants ───────────────────────────────────────────
async function validateAssets(scenes: Scene[], log: pino.Logger): Promise<void> {
  log.info({ count: scenes.length }, "validation médias: début");

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;
    if (!scene.asset_url) continue;

    const expected = scene.asset_type === "image" ? "image/" : "video/";
    let res: Response;

    try {
      res = await fetch(scene.asset_url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(scene.asset_url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          signal: AbortSignal.timeout(15_000),
        });
      }
    } catch (err: unknown) {
      throw new Error(
        `Asset injoignable (scène ${i + 1}/${scenes.length}, ${scene.asset_type}) : ${scene.asset_url} — ${String(err)}`,
      );
    }

    if (!res.ok && res.status !== 206) {
      throw new Error(
        `Asset HTTP ${res.status} (scène ${i + 1}/${scenes.length}) : ${scene.asset_url}`,
      );
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().startsWith(expected)) {
      log.warn({ url: scene.asset_url, ct, expected }, `asset Content-Type inattendu (scène ${i + 1}) — on continue`);
    }

    log.info({ idx: i + 1, type: scene.asset_type, status: res.status }, "asset OK");
  }

  log.info("validation médias: terminée");
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────
function withTimeout<T>(
  promise:   Promise<T>,
  ms:        number,
  label:     string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* ignore */ }
      reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (v)   => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ── Rendu en arrière-plan ─────────────────────────────────────────────────────
async function runRenderInBackground(
  job_id:  string,
  user_id: string,
  ai_plan: AiPlan,
): Promise<void> {
  const log = logger.child({ job_id, user_id, scope: "render-bg" });
  const outputPath = path.join(os.tmpdir(), `remotion-${job_id}.mp4`);
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  try {
    log.info({ scenes: ai_plan.scenes.length }, "rendu: démarrage");

    // Validation des médias (ne bloque pas si asset_url vide)
    const scenesWithUrl = ai_plan.scenes.filter((s) => s.asset_url);
    if (scenesWithUrl.length) {
      await validateAssets(ai_plan.scenes, log);
    }

    // Cap des durées de scène
    const effectivePlan: AiPlan = {
      ...ai_plan,
      scenes: ai_plan.scenes.map((s, i) => {
        if (s.duration > MAX_SCENE_SEC) {
          log.warn({ idx: i + 1, original: s.duration, capped: MAX_SCENE_SEC }, "scène tronquée");
          return { ...s, duration: MAX_SCENE_SEC };
        }
        return s;
      }),
    };

    // ── Browser & Bundle ──────────────────────────────────────────────────────
    log.info("import @remotion/renderer: start");
    const { renderMedia, selectComposition, makeCancelSignal } =
      await import("@remotion/renderer");
    log.info("import @remotion/renderer: OK");

    await ensureBrowserCached(log);

    const serveUrl = await getBundleDir(log);
    log.info({ total_ms: elapsed() }, "bundle: prêt");

    // ── Dimensions ────────────────────────────────────────────────────────────
    const formatDims: Record<string, { width: number; height: number }> = {
      "9:16": { width: 1080, height: 1920 },
      "1:1":  { width: 1080, height: 1080 },
      "16:9": { width: 1920, height: 1080 },
    };
    const dims    = formatDims[effectivePlan.format ?? "9:16"] ?? formatDims["9:16"]!;
    let targetW   = effectivePlan.width  || dims.width;
    let targetH   = effectivePlan.height || dims.height;
    const scale   = Math.min(MAX_WIDTH / targetW, MAX_HEIGHT / targetH, 1);
    if (scale < 1) {
      const [origW, origH] = [targetW, targetH];
      targetW = Math.floor((targetW * scale) / 2) * 2;
      targetH = Math.floor((targetH * scale) / 2) * 2;
      log.warn({ original: `${origW}x${origH}`, capped: `${targetW}x${targetH}` }, "résolution réduite");
    }
    const inputProps = { ...effectivePlan, width: targetW, height: targetH };

    const CHROME_OPTS = {
      disableWebSecurity:        true,
      gl:                        "swiftshader" as const,
      enableMultiProcessOnLinux: false,
      ignoreCertificateErrors:   true,
    } as const;

    // ── selectComposition ─────────────────────────────────────────────────────
    log.info({ width: targetW, height: targetH }, "selectComposition: start");
    const selStart   = Date.now();
    const composition = await selectComposition({
      serveUrl,
      id:          "VideoComposition",
      inputProps,
      chromeMode:       "headless-shell",
      chromiumOptions:  CHROME_OPTS,
    });
    log.info(
      { duration_ms: Date.now() - selStart, frames: composition.durationInFrames, fps: composition.fps },
      "selectComposition: OK",
    );

    // ── renderMedia ───────────────────────────────────────────────────────────
    log.info({ frames: composition.durationInFrames, fps: composition.fps, elapsed_ms: elapsed() }, "renderMedia: start");

    const { cancelSignal, cancel } = makeCancelSignal();

    let lastProgress       = 0;
    let lastRenderedFrames = 0;
    let lastEncodedFrames  = 0;
    let lastProgressAt     = Date.now();
    const renderStart      = Date.now();

    const progressTimer = setInterval(() => {
      const idleMs = Date.now() - lastProgressAt;
      log.info(
        {
          progress:       Math.round(lastProgress * 100),
          renderedFrames: lastRenderedFrames,
          encodedFrames:  lastEncodedFrames,
          totalFrames:    composition.durationInFrames,
          elapsed_ms:     Date.now() - renderStart,
          idle_ms:        idleMs,
        },
        idleMs >= 30_000 ? "renderMedia: STALL (>30s sans progression)" : "renderMedia: progress",
      );
    }, 5_000);

    const renderPromise = renderMedia({
      composition,
      serveUrl,
      codec:          "h264",
      outputLocation: outputPath,
      inputProps,
      cancelSignal,
      concurrency:    1,
      imageFormat:    "jpeg",
      jpegQuality:    80,
      timeoutInMilliseconds: RENDER_TIMEOUT_MS,
      chromeMode:     "headless-shell",
      chromiumOptions: {
        disableWebSecurity:        true,
        gl:                        "swiftshader",
        enableMultiProcessOnLinux: false,
        headless:                  true,
      },
      onBrowserLog: ({ type, text }) => {
        if (type === "error" || type === "warning") {
          log.warn({ chrome_type: type, text }, "chrome console");
        }
      },
      onProgress: ({ progress, renderedFrames, encodedFrames }) => {
        if (progress > lastProgress) lastProgressAt = Date.now();
        lastProgress       = progress;
        lastRenderedFrames = renderedFrames;
        lastEncodedFrames  = encodedFrames;
      },
    });

    try {
      await withTimeout(renderPromise, RENDER_TIMEOUT_MS, "Render", () => {
        log.error("renderMedia: timeout 10min — annulation (cancelSignal)");
        try { cancel(); } catch { /* ignore */ }
      });
    } finally {
      clearInterval(progressTimer);
    }

    log.info({ duration_ms: Date.now() - renderStart }, "renderMedia: OK");

    // ── Upload R2 ─────────────────────────────────────────────────────────────
    const key = `${user_id}/final-videos/${job_id}.mp4`;
    log.info({ key, total_ms: elapsed() }, "upload R2: start");
    const uploadStart = Date.now();
    const videoBuffer = await readFile(outputPath);

    await makeS3().send(new PutObjectCommand({
      Bucket:      R2_BUCKET,
      Key:         key,
      Body:        videoBuffer,
      ContentType: "video/mp4",
    }));

    const resultVideoUrl = `${R2_PUBLIC_URL}/${key}`;
    log.info(
      { resultVideoUrl, size_bytes: videoBuffer.length, duration_ms: Date.now() - uploadStart },
      "upload R2: OK",
    );

    // ── PATCH Supabase completed ──────────────────────────────────────────────
    await updateVideoJob(
      job_id,
      {
        status:           "completed",
        progress:         100,
        result_video_url: resultVideoUrl,
        completed_at:     new Date().toISOString(),
      },
      log,
    );
    log.info({ total_ms: elapsed() }, "rendu: pipeline terminé ✓");

  } catch (err: unknown) {
    const message          = err instanceof Error ? err.message : String(err);
    const stack            = err instanceof Error ? err.stack   : undefined;
    const isRenderTimeout  = /timeout after/i.test(message);
    const isBundleTimeout  = isBundleTimeoutErr(err);

    log.error(
      { error: message, stack, elapsed_ms: elapsed(), is_render_timeout: isRenderTimeout, is_bundle_timeout: isBundleTimeout },
      "rendu: erreur",
    );

    const errorLabel = isBundleTimeout
      ? "Remotion bundle timeout (>2 min)"
      : isRenderTimeout
        ? "Render timeout (>10 min)"
        : message;

    await updateVideoJob(
      job_id,
      { status: "failed", error_message: errorLabel, failed_at: new Date().toISOString() },
      log,
    );
  } finally {
    unlink(outputPath).catch(() => {});
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// GET /healthz
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), bundleReady: cachedBundleDir !== null });
});

// POST /render
app.post("/render", async (req, res): Promise<void> => {
  const reqLog = logger.child({ scope: "POST /render" });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const apiKey = req.headers["x-api-key"] ?? req.headers["X-Api-Key"];
  if (!RENDER_SECRET || apiKey !== RENDER_SECRET) {
    reqLog.warn({ ip: req.ip }, "Unauthorized: x-api-key invalide ou manquant");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ── Validation basique ────────────────────────────────────────────────────
  const body = req.body as Partial<RenderBody>;

  if (!body.job_id || typeof body.job_id !== "string") {
    res.status(400).json({ error: "job_id manquant ou invalide" });
    return;
  }
  if (!body.user_id || typeof body.user_id !== "string") {
    res.status(400).json({ error: "user_id manquant ou invalide" });
    return;
  }
  if (!body.ai_plan || !Array.isArray(body.ai_plan.scenes) || body.ai_plan.scenes.length === 0) {
    res.status(400).json({ error: "ai_plan.scenes manquant ou vide" });
    return;
  }

  const { job_id, user_id, ai_plan } = body;

  reqLog.info({ job_id, user_id, scenes: ai_plan.scenes.length }, "rendu accepté");

  // ── PATCH Supabase → rendering ────────────────────────────────────────────
  await updateVideoJob(
    job_id,
    { status: "rendering", progress: 75, started_at: new Date().toISOString() },
    reqLog,
  );

  // ── Répondre immédiatement à n8n ─────────────────────────────────────────
  // Le rendu continue en arrière-plan. N8n n'a pas à attendre 10 minutes.
  res.status(202).json({ accepted: true, job_id });

  // ── Fire-and-forget ───────────────────────────────────────────────────────
  runRenderInBackground(job_id, user_id, ai_plan).catch((err: unknown) => {
    logger.error({ job_id, err: String(err) }, "runRenderInBackground: erreur non-catchée (bug)");
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info({ port: PORT }, "xeltrix-remotion-service: listening");

  // Warm-up non-bloquant : Chrome + bundle compilés au démarrage
  setImmediate(() => {
    warmupRemotion().catch((err: unknown) => {
      logger.warn({ err: String(err) }, "warm-up: échoué au démarrage (non-fatal)");
    });
  });
});
