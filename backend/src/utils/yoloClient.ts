/**
 * utils/yoloClient.ts
 * -------------------
 * Drop-in replacement for roboflowClient.ts.
 *
 * Routes inference to the in-house SolarVision FastAPI service
 * (services/vision/server.py  POST /vision/infer)  instead of Roboflow.
 *
 * Public API is intentionally identical to roboflowClient.ts so that
 * all call-sites in surveys.ts only need an import-path change.
 *
 * Environment variables:
 *   VISION_SERVICE_URL   Base URL of the FastAPI service
 *                        e.g. http://localhost:8001  (default)
 *                             https://vision.internal.solarpro.com
 *   VISION_API_KEY       Optional bearer token (matches VISION_API_KEY
 *                        set on the FastAPI server).  Leave unset to
 *                        skip auth header.
 *   VISION_CONF_THRESHOLD  Default confidence threshold 0-1 (default 0.25)
 *   VISION_IOU_THRESHOLD   Default IoU NMS threshold  0-1 (default 0.45)
 *   VISION_TIMEOUT_MS    HTTP request timeout in ms     (default 30000)
 */

import fs from "fs/promises";
import path from "path";

// ─── config ───────────────────────────────────────────────────────────────────

function getServiceUrl(): string {
  return (
    process.env.VISION_SERVICE_URL?.replace(/\/$/, "") ??
    "http://localhost:8001"
  );
}

function getApiKey(): string | undefined {
  return process.env.VISION_API_KEY || undefined;
}

function getDefaultConf(): number {
  const v = parseFloat(process.env.VISION_CONF_THRESHOLD ?? "0.25");
  return isNaN(v) ? 0.25 : Math.min(1, Math.max(0.01, v));
}

function getDefaultIou(): number {
  const v = parseFloat(process.env.VISION_IOU_THRESHOLD ?? "0.45");
  return isNaN(v) ? 0.45 : Math.min(1, Math.max(0.01, v));
}

function getTimeoutMs(): number {
  const v = parseInt(process.env.VISION_TIMEOUT_MS ?? "30000", 10);
  return isNaN(v) ? 30_000 : v;
}

// ─── types ────────────────────────────────────────────────────────────────────

/** Options accepted by every public export (mirrors RoboflowInferOptions shape) */
export interface VisionInferOptions {
  /** Confidence threshold 0-1 (default: VISION_CONF_THRESHOLD env or 0.25) */
  confidence?: number;
  /** IoU NMS threshold 0-1 (default: VISION_IOU_THRESHOLD env or 0.45) */
  overlap?: number;
  /** Kept for API compatibility — ignored by YOLOv8 service */
  modelId?: string;
  /** Kept for API compatibility — ignored by YOLOv8 service */
  elecClasses?: string[];
  /** Kept for API compatibility — ignored by YOLOv8 service */
  materialClasses?: string[];
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = getApiKey();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Upload a Buffer to a temp endpoint so the vision service can fetch it,
 * OR — when running on the same host — write it to a temp file and pass
 * the local path.
 *
 * Strategy used here: write to OS temp dir, pass absolute path.
 * For production deployments where vision service runs on a separate host,
 * replace with an S3 pre-signed URL upload instead.
 */
async function bufferToTempPath(image: Buffer): Promise<string> {
  const tmpDir  = process.env.TMPDIR ?? "/tmp";
  const tmpFile = path.join(tmpDir, `sv_infer_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  await fs.writeFile(tmpFile, image);
  return tmpFile;
}

async function cleanupTemp(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Core HTTP call to the vision service.
 *
 * @param imageUrl  URL or absolute local path the vision service can read
 * @param options   inference options
 */
async function callVisionService(
  imageUrl: string,
  options: VisionInferOptions = {},
): Promise<unknown> {
  const url     = `${getServiceUrl()}/vision/infer`;
  const timeout = getTimeoutMs();

  const body = {
    imageUrl,
    conf: options.confidence != null
      ? options.confidence / 100   // surveys.ts passes 0-100; vision service expects 0-1
      : getDefaultConf(),
    iou: options.overlap != null
      ? options.overlap / 100
      : getDefaultIou(),
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url, {
      method : "POST",
      headers: buildHeaders(),
      body   : JSON.stringify(body),
      signal : controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Vision service timed out after ${timeout}ms (url: ${imageUrl.slice(0, 80)})`,
      );
    }
    throw new Error(`Vision service unreachable: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text       = await response.text();
  const parsed     = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null
        ? JSON.stringify(parsed)
        : text;
    throw new Error(`Vision inference failed (${response.status}): ${detail}`);
  }

  return parsed;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API  (same signatures as roboflowClient.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run inference against a raw image Buffer.
 * Writes a temp file, calls vision service, then cleans up.
 */
export async function inferRoboflowFromBuffer(
  image: Buffer,
  options: VisionInferOptions = {},
): Promise<unknown> {
  const tmpPath = await bufferToTempPath(image);
  try {
    return await callVisionService(tmpPath, options);
  } finally {
    await cleanupTemp(tmpPath);
  }
}

/**
 * Alias kept for backward compatibility with roboflowClient consumers.
 */
export async function analyzeImage(
  image: Buffer,
  options: VisionInferOptions = {},
): Promise<unknown> {
  return inferRoboflowFromBuffer(image, options);
}

/**
 * Run inference against a local file path.
 */
export async function inferRoboflowFromFile(
  filePath: string,
  options: VisionInferOptions = {},
): Promise<unknown> {
  const image = await fs.readFile(filePath);
  return inferRoboflowFromBuffer(image, options);
}

/**
 * Run inference from a stored file_path (local disk path) or a remote URL.
 *
 * Handles the two formats produced by storageClient:
 *   - Local path  : "/uploads/filename.jpg"  → read from disk, temp file
 *   - Remote URL  : "https://..."            → pass URL directly to vision service
 */
export async function inferRoboflowFromPath(
  filePathOrUrl: string,
  options: VisionInferOptions = {},
): Promise<unknown> {
  if (
    filePathOrUrl.startsWith("http://") ||
    filePathOrUrl.startsWith("https://")
  ) {
    // Pass the URL directly — vision service will download it
    return callVisionService(filePathOrUrl, options);
  }

  // Local path — resolve from uploads dir
  const localPath = filePathOrUrl.startsWith("/")
    ? require("path").join(__dirname, "..", "..", filePathOrUrl)
    : filePathOrUrl;

  return inferRoboflowFromFile(localPath, options);
}

/**
 * Decode a base64 data URL to a Buffer.
 * Kept for API compatibility — identical to roboflowClient.ts implementation.
 */
export function dataUrlToBuffer(dataUrl: string): Buffer {
  const match = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid data URL format; expected base64 data URL");
  }
  return Buffer.from(match[1], "base64");
}