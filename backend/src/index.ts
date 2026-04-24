import path from "path";
import fs from "fs";

// Load .env before anything else
if (process.env.NODE_ENV !== "production") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  } catch {
    /* dotenv optional */
  }
}

import express, { type Request } from "express";
import cors from "cors";
import multer from "multer";
import surveysRouter from "./routes/surveys";
import categoriesRouter from "./routes/categories";
import usersRouter from "./routes/users";
import roboflowProxyRouter from "./routes/roboflowProxy";
import handoffRouter from "./routes/handoff";
import fallbackSurveyRouter from "./routes/fallbackSurvey";
import openApiRouter from "./routes/openapi";
import bugReportsRouter from "./routes/bugReports";
import webhooksRouter from "./routes/webhooks";
import { requireAuth } from "./middleware/auth";
import { pool } from "./database";
import { uploadFile, isS3Mode } from "./utils/storageClient";
import { startWebhookWorker } from "./services/webhookService";
import { startSqlServerSyncWorker } from "./services/sqlServerSyncService";
import {
  incrementMetric,
  recordTiming,
  getMetricsSnapshot,
} from "./services/metrics";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const IOS_BUNDLE_ID = process.env.IOS_BUNDLE_ID || "com.sitesurvey.mobile";
const APPLE_TEAM_ID = (process.env.APPLE_TEAM_ID || "").trim();

// Only create local uploads dir when not using S3
if (!isS3Mode() && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Use memory storage — storageClient handles the final destination
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files are allowed"));
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// ----------------------------------------------------------------
// CORS
// ----------------------------------------------------------------
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:5173,http://localhost:4173,http://localhost:8081"
)
  .split(",")
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ----------------------------------------------------------------
// Body parsing
// ----------------------------------------------------------------
app.use(express.json({
  limit: "50mb",
  verify: (req, _res, buffer) => {
    (req as Request & { rawBody?: string }).rawBody = buffer.toString("utf8");
  },
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    incrementMetric("api_requests_total");
    recordTiming("http_request_duration_ms", durationMs);

    console.info(
      JSON.stringify({
        type: "http_request",
        request_id: requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: durationMs,
      }),
    );
  });

  next();
});

// ----------------------------------------------------------------
// Public landing page
// ----------------------------------------------------------------
app.get("/.well-known/apple-app-site-association", (_req, res) => {
  const appID = APPLE_TEAM_ID
    ? `${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`
    : IOS_BUNDLE_ID;

  res.type("application/json").send({
    applinks: {
      apps: [],
      details: [
        {
          appID,
          paths: ["/view/*"],
        },
      ],
    },
  });
});

app.use(express.static(PUBLIC_DIR));

app.get("/view/:surveyId", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin/surveys", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin-surveys.html"));
});

app.use(fallbackSurveyRouter);

// ----------------------------------------------------------------
// Serve uploaded photos statically
// ----------------------------------------------------------------
// Serve uploaded photos statically — local mode only
// ----------------------------------------------------------------
if (!isS3Mode()) {
  app.use("/uploads", express.static(UPLOADS_DIR));
}

// ----------------------------------------------------------------
// Health check
// ----------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: "error",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

// ----------------------------------------------------------------
// Survey image upload
// ----------------------------------------------------------------
app.post("/api/surveys/upload", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Image exceeds 10MB limit" });
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
      res.status(400).json({ error: "No image file uploaded" });
      return;
    }

    try {
      const ext = require("path").extname(req.file.originalname) || ".jpg";
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const filePath = await uploadFile(req.file.buffer, filename, req.file.mimetype);
      res.status(201).json({ filePath });
    } catch (uploadErr) {
      const message = uploadErr instanceof Error ? uploadErr.message : "Upload failed";
      res.status(500).json({ error: message });
    }
  });
});

app.get("/api/metrics", requireAuth, (req, res) => {
  if (req.authUser?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }

  res.json(getMetricsSnapshot());
});

// ----------------------------------------------------------------
// API routes
// ----------------------------------------------------------------
app.use("/api/webhooks", webhooksRouter);
app.use("/api/surveys", requireAuth, surveysRouter);
app.use("/api/categories", requireAuth, categoriesRouter);
app.use("/api/users", usersRouter);
app.use("/api/handoff", handoffRouter);
app.use("/api", openApiRouter);
app.use("/api/bug-reports", requireAuth, bugReportsRouter);
app.use("/api/roboflow", requireAuth, roboflowProxyRouter);

// ----------------------------------------------------------------
// 404
// ----------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ----------------------------------------------------------------
// Startup env validation (F-03: fail fast before any request is served)
// ----------------------------------------------------------------
function validateRequiredEnv(): void {
  const REQUIRED: string[] = [
    'SOLARPRO_WEBHOOK_URL',
    'SURVEY_WEBHOOK_SECRET',
    'SOLARPRO_HANDOFF_SECRET',
    'JWT_SECRET',
  ];
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    console.error(
      `[STARTUP] FATAL: Missing required environment variables: ${missing.join(', ')}. ` +
      'Set these before deploying to production.',
    );
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    // In dev/test: warn but continue so local dev without full config still works.
    console.warn('[STARTUP] Continuing in non-production mode with missing env vars.');
  }

  // Validate SOLARPRO_HANDOFF_SECRET length (must be ≥32 chars — matches SolarPro minter requirement)
  const handoffSecret = process.env.SOLARPRO_HANDOFF_SECRET?.trim() ?? '';
  if (handoffSecret && handoffSecret.length < 32) {
    console.error(
      `[STARTUP] FATAL: SOLARPRO_HANDOFF_SECRET must be at least 32 characters ` +
      `(currently ${handoffSecret.length}). SolarPro will reject tokens signed with a short secret.`,
    );
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

// ----------------------------------------------------------------
// Start server
// ----------------------------------------------------------------
if (require.main === module) {
  validateRequiredEnv();
  app.listen(PORT, () => {
    console.log(`Site Survey API running on http://localhost:${PORT}`);
    console.log(`Photo uploads served from /uploads`);
    startWebhookWorker();
    startSqlServerSyncWorker();
  });
}

export default app;
