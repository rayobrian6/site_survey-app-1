/**
 * routes/visionProxy.ts
 * ---------------------
 * Backend proxy for the in-house SolarVision YOLOv8 inference service.
 * Replaces roboflowProxy.ts — route is now mounted at /api/vision.
 *
 * Endpoints:
 *   POST /api/vision/infer    multipart JPEG → inference result
 *   GET  /api/vision/health   liveness pass-through to vision service
 *   GET  /api/vision/model    model metadata pass-through
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/auth";
import { analyzeImage } from "../utils/yoloClient";

const router = Router();

// ─── multer upload (identical limits to old roboflowProxy) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10 MB (relaxed from 2 MB for high-res roof photos)
  },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error("Only JPEG, PNG, and WebP images are supported for inference"));
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function getVisionServiceUrl(): string {
  return (
    process.env.VISION_SERVICE_URL?.replace(/\/$/, "") ??
    "http://localhost:8001"
  );
}

async function proxyGet(path: string, res: Response): Promise<void> {
  try {
    const response = await fetch(`${getVisionServiceUrl()}${path}`);
    const body     = await response.json() as unknown;
    res.status(response.status).json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vision service unavailable";
    res.status(502).json({ error: msg });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/vision/health
 * Liveness pass-through — useful for load-balancer health checks.
 */
router.get("/health", async (_req: Request, res: Response) => {
  await proxyGet("/health", res);
});

/**
 * GET /api/vision/model
 * Returns loaded model metadata (class list, version).
 */
router.get("/model", requireAuth, async (_req: Request, res: Response) => {
  await proxyGet("/vision/model", res);
});

/**
 * POST /api/vision/infer
 *
 * multipart/form-data:
 *   - file          : JPEG / PNG / WebP image (max 10 MB)
 *   - confidence?   : number 0-100  (default: env VISION_CONF_THRESHOLD or 25)
 *   - iou?          : number 0-100  (default: env VISION_IOU_THRESHOLD  or 45)
 *
 * Returns the raw InferResponse from the vision service:
 *   {
 *     source, modelPath, imageWidth, imageHeight,
 *     inferenceMs, detectionCount,
 *     detections: VisionDetection[]
 *   }
 */
router.post("/infer", requireAuth, (req: Request, res: Response) => {
  upload.single("file")(req, res, async (err: unknown) => {
    // ── multer errors ──────────────────────────────────────────────────────
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Image exceeds 10 MB limit" });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(400).json({ error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No image provided" });
      return;
    }

    // ── parse optional overrides ───────────────────────────────────────────
    const body = req.body as {
      confidence?: string | number;
      iou?:        string | number;
    };

    const confidence =
      body.confidence !== undefined ? Number(body.confidence) : undefined;
    const iou =
      body.iou !== undefined ? Number(body.iou) : undefined;

    if (confidence !== undefined && (isNaN(confidence) || confidence < 0 || confidence > 100)) {
      res.status(400).json({ error: "`confidence` must be a number between 0 and 100" });
      return;
    }
    if (iou !== undefined && (isNaN(iou) || iou < 0 || iou > 100)) {
      res.status(400).json({ error: "`iou` must be a number between 0 and 100" });
      return;
    }

    // ── run inference ──────────────────────────────────────────────────────
    try {
      const result = await analyzeImage(req.file.buffer, {
        confidence,
        overlap: iou,
      });
      res.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Inference failed";
      console.error("[visionProxy] POST /api/vision/infer error:", message);
      res.status(502).json({ error: message });
    }
  });
});

export default router;