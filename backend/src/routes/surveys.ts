/**
 * backend/src/routes/surveys.ts
 *
 * All survey-related API endpoints.
 * Uses pool.query from the shared database module throughout.
 * Location is stored as GEOGRAPHY(POINT, 4326) via PostGIS.
 */
import path from "path";
import { Router, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { pool } from "../database";
import { solarSurveySchema } from "../models/Survey";
import { stringify as csvStringify } from "csv-stringify/sync";
import { generateReport, toMarkdown } from "../utils/reportGenerator";
import {
  dataUrlToBuffer,
  inferRoboflowFromBuffer,
  inferRoboflowFromPath,
} from "../utils/roboflowClient";
import { uploadFile } from "../utils/storageClient";
import {
  enqueueSurveyCompleteWebhook,
  ensureWebhookDeliveriesTable,
  processWebhookQueue,
  softDeleteSurveyAndQueueCleanup,
} from "../services/webhookService";
import {
  incrementMetric,
  recordTiming,
} from "../services/metrics";

let surveysSoftDeleteReady: Promise<void> | null = null;

async function ensureSurveySoftDeleteColumn(): Promise<void> {
  if (!surveysSoftDeleteReady) {
    surveysSoftDeleteReady = (async () => {
      try {
        await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS project_id UUID`);
        await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS category_id UUID`);
        await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS category_name VARCHAR(100)`);
        await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS metadata JSONB`);
        await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
          await pool.query(`ALTER TABLE surveys ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID`);
          await pool.query(`CREATE INDEX IF NOT EXISTS surveys_submitted_by_user_id_idx ON surveys (submitted_by_user_id)`);
      } catch (error) {
        console.warn("survey schema migration skipped:", error);
      }
    })().catch((error) => {
      surveysSoftDeleteReady = null;
      throw error;
    });
  }

  await surveysSoftDeleteReady;
}

const router = Router();

const uuidV4Schema = z.string().uuid();

function isValidUuid(value: string): boolean {
  return uuidV4Schema.safeParse(value).success;
}

function normalizeOptionalUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isValidUuid(trimmed) ? trimmed : null;
}

function normalizeCategoryName(
  categoryId: unknown,
  categoryName: unknown,
): string | null {
  if (typeof categoryName === "string" && categoryName.trim()) {
    return categoryName.trim();
  }
  if (typeof categoryId === "string" && categoryId.trim() && !isValidUuid(categoryId.trim())) {
    return categoryId.trim();
  }
  return null;
}

interface Queryable {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

async function resolveExistingProjectId(
  db: Queryable,
  value: unknown,
): Promise<string | null> {
  const candidate = normalizeOptionalUuid(value);
  if (!candidate) return null;

  try {
    const { rows } = await db.query(
      `SELECT 1 FROM projects WHERE id = $1 LIMIT 1`,
      [candidate],
    );

    return rows.length > 0 ? candidate : null;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === "42P01" || pgError.code === "42501") {
      // projects table missing or inaccessible in this environment
      return null;
    }
    throw error;
  }
}

async function resolveExistingCategoryId(
  db: Queryable,
  value: unknown,
): Promise<string | null> {
  const candidate = normalizeOptionalUuid(value);
  if (!candidate) return null;

  try {
    const { rows } = await db.query(
      `SELECT 1 FROM categories WHERE id = $1 LIMIT 1`,
      [candidate],
    );

    return rows.length > 0 ? candidate : null;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === "42P01" || pgError.code === "42501") {
      // categories table missing or inaccessible in this environment
      return null;
    }
    throw error;
  }
}

function respondValidationError(
  res: Response,
  message: string,
  field?: string,
): void {
  res.status(422).json({
    error: {
      code: "VALIDATION_FAILED",
      message,
      field,
    },
  });
}

function requireUuidParam(
  req: Request,
  res: Response,
  field: "id" | "photoId",
): boolean {
  const raw = req.params[field];
  if (!raw || !isValidUuid(raw)) {
    respondValidationError(res, `${field} must be a valid UUID`, field);
    return false;
  }
  return true;
}

// ----------------------------------------------------------------
// SSE — real-time survey event broadcasting
// ----------------------------------------------------------------
type SseEventType = "survey.created" | "survey.updated" | "survey.deleted";

interface SseClient {
  id: string;
  res: Response;
}

const sseClients: SseClient[] = [];

/** Register a new SSE connection and remove it when the client disconnects. */
function addSseClient(res: Response): SseClient {
  const client: SseClient = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, res };
  sseClients.push(client);
  res.on("close", () => {
    const idx = sseClients.indexOf(client);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
  return client;
}

/** Broadcast a typed event to all connected SSE clients. */
export function broadcastSurveyEvent(type: SseEventType, payload: unknown): void {
  if (sseClients.length === 0) return;
  const data = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const client of sseClients) {
    try {
      client.res.write(`event: ${type}\ndata: ${data}\n\n`);
    } catch {
      // Client disconnected mid-write — will be cleaned up on "close"
    }
  }
}

// ----------------------------------------------------------------
// Multer — memory storage; storageClient handles final destination
// ----------------------------------------------------------------
// Only allow image MIME types
const imageFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed"));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: imageFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per photo
});

// ----------------------------------------------------------------
// TypeScript interfaces
// ----------------------------------------------------------------
interface ChecklistItemInput {
  label: string;
  status: string;
  notes?: string;
  sort_order?: number;
}

interface PhotoInput {
  filename?: string;
  label?: string;
  data_url?: string; // base64 — used by mobile sync
  mime_type?: string;
  captured_at?: string;
}

/** GeoJSON Point accepted as the `location` field in a request body. */
interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number]; // [longitude, latitude]
}

/**
 * Category-specific metadata stored as JSONB.
 * The `type` discriminator matches the category_id slug so the API
 * and the design team can identify which schema is in use.
 */
interface GroundMountMetadata {
  type: "ground_mount";
  soil_type: "Rocky" | "Sandy" | "Clay" | "Organic/Loam" | null;
  slope_degrees: number | null;
  trenching_path: string;
  vegetation_clearing: boolean;
}
interface RoofMountMetadata {
  type: "roof_mount";
  roof_material: "Asphalt Shingle" | "Metal" | "Tile" | "Membrane" | null;
  rafter_size: "2x4" | "2x6" | "2x8" | null;
  rafter_spacing: "16in" | "24in" | null;
  roof_age_years: number | null;
  azimuth: number | null;
}
interface SolarFencingMetadata {
  type: "solar_fencing";
  perimeter_length_ft: number | null;
  lower_shade_risk: boolean;
  foundation_type: "Driven Piles" | "Concrete Footer" | null;
  bifacial_surface: "Concrete" | "Gravel" | "Grass" | "Dirt" | null;
}
type SurveyMetadata =
  | GroundMountMetadata
  | RoofMountMetadata
  | SolarFencingMetadata;

interface InferenceLogInput {
  surveyId: string;
  photoId: string;
  modelId: string | null;
  options: {
    confidence?: number;
    overlap?: number;
    elec_classes?: string[];
    material_classes?: string[];
  };
  inference: unknown;
}

interface SurveyInput {
  project_name: string;
  project_id?: string;
  category_id?: string;
  category_name?: string;
  inspector_name: string;
  site_name: string;
  site_address?: string;
  /** GeoJSON Point — takes priority over latitude/longitude fields */
  location?: GeoJsonPoint;
  latitude?: number;
  longitude?: number;
  gps_accuracy?: number;
  survey_date?: string;
  notes?: string;
  status?: string;
  device_id?: string;
  /** Category-specific fields (Ground Mount / Roof Mount / Solar Fencing) */
  metadata?: SurveyMetadata | null;
  checklist?: ChecklistItemInput[];
  photos?: PhotoInput[];
  // F-06: Ownership routing — populated from SolarPro handoff JWT claims
  // so the webhook payload can carry them back for owner resolution.
  solarpro_user_id?: string | null;
  solarpro_project_id?: string | null;
  solarpro_email?: string | null;
  solarpro_org_id?: string | null;
}

let inferenceLogsTableReady: Promise<void> | null = null;

async function ensureInferenceLogsTable(): Promise<void> {
  if (!inferenceLogsTableReady) {
    inferenceLogsTableReady = pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS photo_inference_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          survey_id UUID NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
          photo_id UUID NOT NULL REFERENCES survey_photos(id) ON DELETE CASCADE,
          model_id VARCHAR(255),
          request_options JSONB NOT NULL DEFAULT '{}',
          inference JSONB NOT NULL,
          prediction_count INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        inferenceLogsTableReady = null;
        throw error;
      });
  }

  await inferenceLogsTableReady;
}

function normalizeInferenceForStorage(inference: unknown): unknown {
  if (inference === null || inference === undefined) {
    return { raw: null };
  }
  if (typeof inference === "object") {
    return inference;
  }
  return { raw: inference };
}

function getPredictionCount(inference: unknown): number {
  if (!inference || typeof inference !== "object") return 0;
  const root = inference as Record<string, unknown>;

  if (Array.isArray(root.predictions)) {
    return root.predictions.length;
  }

  if (
    Array.isArray(root.outputs) &&
    root.outputs.length > 0 &&
    root.outputs[0] &&
    typeof root.outputs[0] === "object"
  ) {
    const firstOutput = root.outputs[0] as Record<string, unknown>;
    if (Array.isArray(firstOutput.predictions)) {
      return firstOutput.predictions.length;
    }
  }

  if (root.result && typeof root.result === "object") {
    const nestedResult = root.result as Record<string, unknown>;
    if (Array.isArray(nestedResult.predictions)) {
      return nestedResult.predictions.length;
    }
  }

  return 0;
}

async function insertInferenceLog(input: InferenceLogInput): Promise<void> {
  await ensureInferenceLogsTable();

  await pool.query(
    `INSERT INTO photo_inference_logs
      (survey_id, photo_id, model_id, request_options, inference, prediction_count)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      input.surveyId,
      input.photoId,
      input.modelId,
      JSON.stringify(input.options),
      JSON.stringify(normalizeInferenceForStorage(input.inference)),
      getPredictionCount(input.inference),
    ],
  );
}

function requireAdmin(req: Request, res: Response): boolean {
  if (req.authUser?.role === "admin") {
    return true;
  }

  res.status(403).json({ error: "Admin access required" });
  return false;
}

// ----------------------------------------------------------------
// Coordinate helpers
// ----------------------------------------------------------------

/**
 * Extract (lon, lat) from either a GeoJSON Point or explicit lat/lon fields.
 * Returns null when no location data is present.
 */
function extractCoords(
  body: SurveyInput,
): { lon: number; lat: number; accuracy?: number } | null {
  if (
    body.location?.type === "Point" &&
    Array.isArray(body.location.coordinates)
  ) {
    const [lon, lat] = body.location.coordinates;
    return { lon, lat };
  }
  if (body.latitude != null && body.longitude != null) {
    return {
      lon: body.longitude,
      lat: body.latitude,
      accuracy: body.gps_accuracy,
    };
  }
  return null;
}

/**
 * Build the ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography expression
 * and append lon/lat to the params array.
 * Returns the SQL expression string to embed in a query.
 */
function geoExpr(params: unknown[], lon: number, lat: number): string {
  params.push(lon, lat);
  const lonIdx = params.length - 1;
  const latIdx = params.length;
  return `ST_SetSRID(ST_MakePoint($${lonIdx}, $${latIdx}), 4326)::geography`;
}

// ----------------------------------------------------------------
// DB helpers
// ----------------------------------------------------------------

/**
 * Fetch a complete survey (checklist + photos) by ID.
 * Uses ST_AsGeoJSON to serialise the geography point for the response.
 */
async function fetchSurveyFull(id: string) {
  await ensureSurveySoftDeleteColumn();

  let rows: Array<Record<string, unknown>> = [];

  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT
         s.id, s.project_name, s.project_id, s.category_id, s.category_name,
         s.inspector_name, s.site_name, s.site_address,
         s.latitude, s.longitude, s.gps_accuracy,
         ST_AsGeoJSON(s.location::geometry)::jsonb AS location_geojson,
         s.survey_date, s.notes, s.status, s.device_id, s.metadata,
         s.synced_at, s.created_at, s.updated_at
       FROM surveys s
       WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id],
    );
    rows = result.rows;
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    const missingDeletedAt =
      pgError.code === "42703" ||
      (pgError.message ?? "").toLowerCase().includes("deleted_at");

    if (!missingDeletedAt) throw error;

    const fallback = await pool.query<Record<string, unknown>>(
      `SELECT
         s.id, s.project_name, s.project_id, s.category_id, s.category_name,
         s.inspector_name, s.site_name, s.site_address,
         s.latitude, s.longitude, s.gps_accuracy,
         ST_AsGeoJSON(s.location::geometry)::jsonb AS location_geojson,
         s.survey_date, s.notes, s.status, s.device_id, s.metadata,
         s.synced_at, s.created_at, s.updated_at
       FROM surveys s
       WHERE s.id = $1`,
      [id],
    );

    rows = fallback.rows;
  }

  if (rows.length === 0) return null;
  const survey = rows[0];

  const { rows: checklist } = await pool.query(
    `SELECT id, survey_id, label, status, notes, sort_order, created_at
       FROM checklist_items
      WHERE survey_id = $1
      ORDER BY sort_order, created_at`,
    [id],
  );

  const { rows: photos } = await pool.query(
    `SELECT id, survey_id, filename, label, file_path, mime_type, captured_at, created_at
       FROM survey_photos
      WHERE survey_id = $1
      ORDER BY captured_at`,
    [id],
  );

  return { ...survey, checklist, photos };
}

/** Replace all checklist items for a survey within a transaction client. */
async function upsertChecklist(
  client: import("pg").PoolClient,
  surveyId: string,
  items: ChecklistItemInput[],
): Promise<void> {
  await client.query("DELETE FROM checklist_items WHERE survey_id = $1", [
    surveyId,
  ]);
  for (let i = 0; i < items.length; i++) {
    const { label, status = "pending", notes = "" } = items[i];
    await client.query(
      `INSERT INTO checklist_items (survey_id, label, status, notes, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [surveyId, label, status, notes, i],
    );
  }
}

/** Replace all photos (base64 variant) for a survey within a transaction client. */
async function upsertPhotos(
  client: import("pg").PoolClient,
  surveyId: string,
  photos: PhotoInput[],
): Promise<void> {
  await client.query("DELETE FROM survey_photos WHERE survey_id = $1", [
    surveyId,
  ]);
  for (const p of photos) {
    await client.query(
      `INSERT INTO survey_photos
         (survey_id, filename, label, data_url, mime_type, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        surveyId,
        p.filename ?? null,
        p.label ?? null,
        p.data_url ?? null,
        p.mime_type ?? "image/jpeg",
        p.captured_at ? new Date(p.captured_at) : new Date(),
      ],
    );
  }
}

/**
 * GET /api/surveys/events
 *
 * Server-Sent Events stream. Clients subscribe once and receive
 * real-time survey.created / survey.updated / survey.deleted events.
 * The connection is kept alive with a 30-second heartbeat comment.
 */
router.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
  res.flushHeaders();

  // Send an initial connection-established event
  res.write("event: connected\ndata: {}\n\n");

  addSseClient(res);

  // Heartbeat every 30 s to prevent proxy/load-balancer timeouts
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30_000);

  res.on("close", () => clearInterval(heartbeat));
});

/**
 * POST /api/surveys/validate/solar
 *
 * Validates a solar survey payload against the shared Zod schema.
 * This is intentionally separate from the persisted survey CRUD shape,
 * which stores broader workflow data plus category-specific metadata.
 */
router.post("/validate/solar", async (req: Request, res: Response) => {
  const parsed = solarSurveySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid solar survey payload",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    });
    return;
  }

  res.status(200).json({
    valid: true,
    data: parsed.data,
  });
});

// ================================================================
// EXPORT ROUTES — must be declared BEFORE /:id to avoid shadowing
// ================================================================

/**
 * GET /api/surveys/export/geojson
 *
 * Returns a GeoJSON FeatureCollection of all surveys.
 * Supports optional query filters: project_id, status, category_id.
 * Uses ST_AsGeoJSON(location::geometry) so GIS tools can import directly.
 */
router.get("/export/geojson", async (req: Request, res: Response) => {
  try {
    await ensureSurveySoftDeleteColumn();
    const { project_id, status, category_id } = req.query as Record<
      string,
      string
    >;
    const conditions: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (project_id) {
      conditions.push(`s.project_id  = $${params.push(project_id)}`);
    }
    if (status) {
      conditions.push(`s.status       = $${params.push(status)}`);
    }
    if (category_id) {
      conditions.push(`s.category_id  = $${params.push(category_id)}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.project_name,
         s.category_name,
         s.inspector_name,
         s.site_name,
         s.site_address,
         s.latitude,
         s.longitude,
         s.gps_accuracy,
         s.survey_date,
         s.notes,
         s.status,
         s.metadata,
         s.created_at,
         s.updated_at,
         -- ST_AsGeoJSON converts the GEOGRAPHY column to a GeoJSON geometry object
         ST_AsGeoJSON(s.location::geometry)::jsonb AS geometry,
         (
           SELECT json_agg(
             json_build_object(
               'label',  c.label,
               'status', c.status,
               'notes',  c.notes
             ) ORDER BY c.sort_order
           )
           FROM checklist_items c
           WHERE c.survey_id = s.id
         ) AS checklist
       FROM surveys s
       ${where}
       ORDER BY s.survey_date DESC`,
      params,
    );

    const features = rows.map((row) => ({
      type: "Feature" as const,
      geometry: row.geometry ?? null,
      properties: {
        id: row.id,
        project_name: row.project_name,
        category: row.category_name,
        inspector: row.inspector_name,
        site_name: row.site_name,
        site_address: row.site_address,
        latitude: row.latitude,
        longitude: row.longitude,
        gps_accuracy_m: row.gps_accuracy,
        survey_date: row.survey_date,
        status: row.status,
        notes: row.notes,
        /** Category-specific metadata — Ground Mount, Roof Mount, or Solar Fencing fields */
        metadata: row.metadata ?? null,
        checklist: row.checklist ?? [],
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));

    const geojson = {
      type: "FeatureCollection" as const,
      features,
      metadata: {
        exported_at: new Date().toISOString(),
        total_records: features.length,
        crs: "EPSG:4326",
      },
    };

    res.setHeader("Content-Type", "application/geo+json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="site_surveys_${Date.now()}.geojson"`,
    );
    res.json(geojson);
  } catch (err) {
    console.error("GET /api/surveys/export/geojson error:", err);
    res.status(500).json({ error: "Failed to export GeoJSON" });
  }
});

/**
 * GET /api/surveys/export/csv
 *
 * Exports a flat CSV with one row per survey.
 * latitude and longitude are explicit columns so the data can be
 * imported directly into GIS / CAD tools (e.g. QGIS, AutoCAD Map 3D).
 * Supports the same optional query filters as the GeoJSON endpoint.
 */
router.get("/export/csv", async (req: Request, res: Response) => {
  try {
    await ensureSurveySoftDeleteColumn();
    const { project_id, status, category_id } = req.query as Record<
      string,
      string
    >;
    const conditions: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (project_id) {
      conditions.push(`s.project_id  = $${params.push(project_id)}`);
    }
    if (status) {
      conditions.push(`s.status       = $${params.push(status)}`);
    }
    if (category_id) {
      conditions.push(`s.category_id  = $${params.push(category_id)}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.project_name,
         s.category_name,
         s.inspector_name,
         s.site_name,
         s.site_address,
         s.latitude,
         s.longitude,
         s.gps_accuracy,
         s.survey_date,
         s.notes,
         s.status,
         s.metadata,
         s.created_at,
         s.updated_at
       FROM surveys s
       ${where}
       ORDER BY s.survey_date DESC`,
      params,
    );
    const filename = `site_surveys_${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (rows.length === 0) {
      res.send(
        "id,project_name,category,inspector_name,site_name,site_address," +
          "latitude,longitude,gps_accuracy_m,survey_date,status,notes," +
          // Ground Mount columns
          "soil_type,slope_degrees,trenching_path,vegetation_clearing," +
          // Roof Mount columns
          "roof_material,rafter_size,rafter_spacing,roof_age_years,azimuth," +
          // Solar Fencing columns
          "perimeter_length_ft,lower_shade_risk,foundation_type,bifacial_surface," +
          "metadata_json,created_at,updated_at\n",
      );
      return;
    }

    const csv = csvStringify(
      rows.map((r) => {
        // Parse the JSONB metadata into typed fields for clean CSV columns
        const meta = r.metadata as Record<string, unknown> | null;
        const metaType = meta?.type as string | undefined;

        return {
          id: r.id,
          project_name: r.project_name,
          category: r.category_name ?? "",
          inspector_name: r.inspector_name,
          site_name: r.site_name,
          site_address: r.site_address ?? "",
          latitude: r.latitude ?? "",
          longitude: r.longitude ?? "",
          gps_accuracy_m: r.gps_accuracy ?? "",
          survey_date: r.survey_date
            ? new Date(r.survey_date as string).toISOString()
            : "",
          status: r.status,
          notes: r.notes ?? "",
          // --- Ground Mount ---
          soil_type: metaType === "ground_mount" ? (meta?.soil_type ?? "") : "",
          slope_degrees:
            metaType === "ground_mount" ? (meta?.slope_degrees ?? "") : "",
          trenching_path:
            metaType === "ground_mount" ? (meta?.trenching_path ?? "") : "",
          vegetation_clearing:
            metaType === "ground_mount"
              ? String(meta?.vegetation_clearing ?? "")
              : "",
          // --- Roof Mount ---
          roof_material:
            metaType === "roof_mount" ? (meta?.roof_material ?? "") : "",
          rafter_size:
            metaType === "roof_mount" ? (meta?.rafter_size ?? "") : "",
          rafter_spacing:
            metaType === "roof_mount" ? (meta?.rafter_spacing ?? "") : "",
          roof_age_years:
            metaType === "roof_mount" ? (meta?.roof_age_years ?? "") : "",
          azimuth: metaType === "roof_mount" ? (meta?.azimuth ?? "") : "",
          // --- Solar Fencing ---
          perimeter_length_ft:
            metaType === "solar_fencing"
              ? (meta?.perimeter_length_ft ?? "")
              : "",
          lower_shade_risk:
            metaType === "solar_fencing"
              ? String(meta?.lower_shade_risk ?? "")
              : "",
          foundation_type:
            metaType === "solar_fencing" ? (meta?.foundation_type ?? "") : "",
          bifacial_surface:
            metaType === "solar_fencing" ? (meta?.bifacial_surface ?? "") : "",
          // Raw JSON for any tooling that prefers it
          metadata_json: meta ? JSON.stringify(meta) : "",
          created_at: new Date(r.created_at as string).toISOString(),
          updated_at: new Date(r.updated_at as string).toISOString(),
        };
      }),
      { header: true },
    );

    res.send(csv);
  } catch (err) {
    console.error("GET /api/surveys/export/csv error:", err);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

// ================================================================
// BATCH SYNC  (offline-first mobile support)
// ================================================================

/**
 * POST /api/surveys/sync
 *
 * Accepts an array of surveys created offline on a mobile device.
 * Each entry includes its local UUID so the client can reconcile.
 */
router.post("/sync", async (req: Request, res: Response) => {
  const syncStartedAt = Date.now();
  const { device_id, surveys } = req.body as {
    device_id?: string;
    surveys: Array<{
      action: "create" | "update";
      survey: SurveyInput & { id?: string };
    }>;
  };

  await ensureSurveySoftDeleteColumn();

  if (!Array.isArray(surveys) || surveys.length === 0) {
    res.status(400).json({ error: "surveys array is required" });
    return;
  }

  for (const entry of surveys) {
    if (
      entry.survey.id !== undefined &&
      entry.survey.id !== null &&
      !isValidUuid(String(entry.survey.id))
    ) {
      respondValidationError(
        res,
        "survey.id must be a valid UUID",
        "id",
      );
      return;
    }
  }

  const results: Array<{
    id: string;
    action: string;
    success: boolean;
    error?: string;
  }> = [];
  const client = await pool.connect();

  try {
    for (const { action, survey } of surveys) {
      try {
        await client.query("BEGIN");

        const coords = extractCoords(survey);

        if (action === "create") {
          // Use the client-generated UUID so we can return it to the device
          const { rows: idRows } = await client.query(
            "SELECT gen_random_uuid() AS id",
          );
          const surveyId: string =
            (survey.id as string) || (idRows[0].id as string);

          const normalizedProjectId = await resolveExistingProjectId(
            client,
            survey.project_id,
          );
          const normalizedCategoryId = await resolveExistingCategoryId(
            client,
            survey.category_id,
          );
          const normalizedCategoryName = normalizeCategoryName(
            survey.category_id,
            survey.category_name,
          );

          const insertParams: unknown[] = [
            surveyId,
            survey.project_name,
            normalizedProjectId,
            normalizedCategoryId,
            normalizedCategoryName,
            survey.inspector_name,
            survey.site_name,
            survey.site_address ?? null,
            coords?.lat ?? null,
            coords?.lon ?? null,
            coords?.accuracy ?? null,
          ];

          const locationSql = coords
            ? geoExpr(insertParams, coords.lon, coords.lat)
            : "NULL";

          insertParams.push(
            survey.survey_date ? new Date(survey.survey_date) : new Date(),
            survey.notes ?? null,
            survey.status ?? "submitted",
            device_id ?? survey.device_id ?? null,
            survey.metadata != null ? JSON.stringify(survey.metadata) : null,
            // F-06: Ownership routing claims from SolarPro handoff JWT
            (survey as SurveyInput).solarpro_user_id ?? null,
            (survey as SurveyInput).solarpro_project_id ?? null,
            (survey as SurveyInput).solarpro_email ?? null,
            (survey as SurveyInput).solarpro_org_id ?? null,
              // F-14: track which authenticated user created this survey (safe deletion)
              req.authUser?.userId ?? null,     // submitted_by_user_id
          );

          await client.query(
            `INSERT INTO surveys
               (id, project_name, project_id, category_id, category_name,
                inspector_name, site_name, site_address,
                latitude, longitude, gps_accuracy, location,
                survey_date, notes, status, device_id, metadata,
                solarpro_user_id, solarpro_project_id, solarpro_email, solarpro_org_id,
                submitted_by_user_id,
                synced_at)
             VALUES
               ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                ${locationSql},
                $${insertParams.length - 9},
                $${insertParams.length - 8},
                $${insertParams.length - 7},
                $${insertParams.length - 6},
                $${insertParams.length - 5},
                $${insertParams.length - 4},
                $${insertParams.length - 3},
                $${insertParams.length - 2},
                $${insertParams.length - 1},
                $${insertParams.length},
                NOW())
             ON CONFLICT (id) DO UPDATE SET
               project_name = EXCLUDED.project_name,
               project_id = EXCLUDED.project_id,
               category_id = EXCLUDED.category_id,
               category_name = EXCLUDED.category_name,
               inspector_name = EXCLUDED.inspector_name,
               site_name = EXCLUDED.site_name,
               site_address = EXCLUDED.site_address,
               latitude = EXCLUDED.latitude,
               longitude = EXCLUDED.longitude,
               gps_accuracy = EXCLUDED.gps_accuracy,
               location = EXCLUDED.location,
               survey_date = EXCLUDED.survey_date,
               notes = EXCLUDED.notes,
               status = EXCLUDED.status,
               device_id = EXCLUDED.device_id,
               metadata = EXCLUDED.metadata,
               solarpro_user_id    = COALESCE(EXCLUDED.solarpro_user_id,    surveys.solarpro_user_id),
               solarpro_project_id = COALESCE(EXCLUDED.solarpro_project_id, surveys.solarpro_project_id),
               solarpro_email      = COALESCE(EXCLUDED.solarpro_email,      surveys.solarpro_email),
               solarpro_org_id     = COALESCE(EXCLUDED.solarpro_org_id,     surveys.solarpro_org_id),
               submitted_by_user_id = COALESCE(surveys.submitted_by_user_id, EXCLUDED.submitted_by_user_id),
               synced_at = NOW(),
               updated_at = NOW()`,

            insertParams,
          );

          if (survey.checklist?.length)
            await upsertChecklist(client, surveyId, survey.checklist);
          if (survey.photos?.length)
            await upsertPhotos(client, surveyId, survey.photos);

          await client.query("COMMIT");
          results.push({ id: surveyId, action: "created", success: true });
        } else if (action === "update" && survey.id) {
          const coords = extractCoords(survey);
          const normalizedProjectId = await resolveExistingProjectId(
            client,
            survey.project_id,
          );
          const normalizedCategoryId = await resolveExistingCategoryId(
            client,
            survey.category_id,
          );
          const normalizedCategoryName = normalizeCategoryName(
            survey.category_id,
            survey.category_name,
          );

          const updateParams: unknown[] = [
            survey.id,
            survey.project_name ?? null,
            normalizedProjectId,
            normalizedCategoryId,
            normalizedCategoryName,
            survey.inspector_name ?? null,
            survey.site_name ?? null,
            survey.site_address ?? null,
            coords?.lat ?? null,
            coords?.lon ?? null,
            coords?.accuracy ?? null,
          ];

          const locationSql = coords
            ? geoExpr(updateParams, coords.lon, coords.lat)
            : "location"; // keep existing value

          updateParams.push(
            survey.notes ?? null,
            survey.status ?? null,
            survey.metadata != null ? JSON.stringify(survey.metadata) : null,
          );

          await client.query(
            `UPDATE surveys SET
               project_name   = COALESCE($2,  project_name),
               project_id     = COALESCE($3,  project_id),
               category_id    = COALESCE($4,  category_id),
               category_name  = COALESCE($5,  category_name),
               inspector_name = COALESCE($6,  inspector_name),
               site_name      = COALESCE($7,  site_name),
               site_address   = COALESCE($8,  site_address),
               latitude       = COALESCE($9,  latitude),
               longitude      = COALESCE($10, longitude),
               gps_accuracy   = COALESCE($11, gps_accuracy),
               location       = ${locationSql},
               notes          = COALESCE($${updateParams.length - 2}, notes),
               status         = COALESCE($${updateParams.length - 1}, status),
               metadata       = COALESCE($${updateParams.length}::jsonb, metadata),
               updated_at     = NOW()
             WHERE id = $1`,
            updateParams,
          );

          if (survey.checklist?.length)
            await upsertChecklist(client, survey.id, survey.checklist);
          if (survey.photos?.length)
            await upsertPhotos(client, survey.id, survey.photos);

          await client.query("COMMIT");
          results.push({ id: survey.id, action: "updated", success: true });
        }
      } catch (err) {
        await client.query("ROLLBACK");
        results.push({
          id: (survey as { id?: string }).id ?? "unknown",
          action,
          success: false,
          error: String(err),
        });
      }
    }

    const syncedCount = results.filter((r) => r.success).length;
    const errorCount = results.length - syncedCount;
    if (syncedCount > 0) incrementMetric("survey_sync_success_total", syncedCount);
    if (errorCount > 0) incrementMetric("survey_sync_error_total", errorCount);
    recordTiming("survey_sync_duration_ms", Date.now() - syncStartedAt);

    console.info(
      JSON.stringify({
        type: "survey_sync_summary",
        device_id: device_id ?? null,
        total: results.length,
        success: syncedCount,
        failed: errorCount,
      }),
    );

    res.json({ synced: syncedCount, results });
  } finally {
    client.release();
  }
});

/**
 * POST /api/surveys/:id/complete
 *
 * Marks a survey as completed and queues a webhook notification.
 */
router.post("/:id/complete", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;

  try {
    await ensureSurveySoftDeleteColumn();
    await ensureWebhookDeliveriesTable();

    const surveyId = req.params.id;

    const { rows: existingDeliveryRows } = await pool.query<{
      event_id: string;
    }>(
      `SELECT event_id::text AS event_id
         FROM webhook_deliveries
        WHERE survey_id = $1 AND event_type = 'survey.completed'
        ORDER BY created_at ASC
        LIMIT 1`,
      [surveyId],
    );

    if (existingDeliveryRows.length > 0) {
      const { rows: surveyRows } = await pool.query<{ status: string }>(
        `SELECT status
           FROM surveys
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [surveyId],
      );

      if (surveyRows.length === 0) {
        res.status(404).json({ error: "Survey not found" });
        return;
      }

      res.json({
        survey_id: surveyId,
        status: surveyRows[0].status,
        event_id: existingDeliveryRows[0].event_id,
      });
      return;
    }

    const completedAt = new Date().toISOString();

    const { rows: updatedRows } = await pool.query<{
      id: string;
      status: string;
      project_id: string | null;
      project_name: string;
      inspector_name: string;
      site_name: string;
      // F-06: Ownership routing columns
      solarpro_user_id: string | null;
      solarpro_project_id: string | null;
      solarpro_email: string | null;
    }>(
      `UPDATE surveys
          SET status = 'submitted',
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text, status, project_id::text, project_name, inspector_name, site_name,
                  solarpro_user_id, solarpro_project_id, solarpro_email`,
      [surveyId],
    );

    if (updatedRows.length === 0) {
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    const survey = updatedRows[0];

    const eventId = await enqueueSurveyCompleteWebhook({
      survey_id: survey.id,
      status: "submitted",
      project_id:
        typeof survey.project_id === "string"
          ? survey.project_id
          : survey.project_id === null
            ? null
            : null,
      project_name: survey.project_name,
      inspector_name: survey.inspector_name,
      site_name: survey.site_name,
      completed_at: completedAt,
      // F-06: Ownership routing — read from survey record
      solarpro_user_id: survey.solarpro_user_id ?? null,
      solarpro_project_id: survey.solarpro_project_id ?? null,
      solarpro_email: survey.solarpro_email ?? null,
    });

    // NOTE: processWebhookQueue() was previously called inline here.
    // Removed — the 30-second background worker handles delivery.
    // Calling it inline blocked the HTTP response for up to 10 × fetch-timeout
    // during SolarPro outages, causing the inspector's app to hang on submit.

    incrementMetric("webhook_enqueued_total");

    console.info(
      JSON.stringify({
        type: "survey_completed",
        survey_id: survey.id,
        event_id: eventId,
        project_id: survey.project_id,
        status: survey.status,
      }),
    );

    res.json({
      survey_id: survey.id,
      status: survey.status,
      event_id: eventId,
    });
  } catch (err) {
    console.error("POST /api/surveys/:id/complete error:", err);
    res.status(500).json({ error: "Failed to complete survey" });
  }
});

router.get("/admin/webhook-deliveries", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureWebhookDeliveriesTable();

    const { survey_id, status, limit = "100", offset = "0" } = req.query as Record<
      string,
      string
    >;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (survey_id) {
      if (!isValidUuid(survey_id)) {
        respondValidationError(res, "survey_id must be a valid UUID", "survey_id");
        return;
      }
      conditions.push(`survey_id = $${params.push(survey_id)}`);
    }

    if (status) {
      conditions.push(`status = $${params.push(status)}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const parsedLimit = Number.parseInt(limit, 10);
    const parsedOffset = Number.parseInt(offset, 10);
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const safeOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

    const { rows: countRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM webhook_deliveries ${where}`,
      params,
    );

    params.push(safeLimit, safeOffset);

    const { rows } = await pool.query(
      `SELECT
         id::text,
         survey_id::text,
         event_type,
         event_id::text,
         payload,
         status,
         attempt_count,
         next_attempt_at,
         last_error,
         created_at,
         updated_at
       FROM webhook_deliveries
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    res.json({
      deliveries: rows,
      total: countRows[0]?.total ?? 0,
    });
  } catch (err) {
    console.error("GET /api/surveys/admin/webhook-deliveries error:", err);
    res.status(500).json({ error: "Failed to retrieve webhook deliveries" });
  }
});

router.get("/admin/surveys", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    await ensureSurveySoftDeleteColumn();

    const { status, project_id, limit = "100", offset = "0" } = req.query as Record<
      string,
      string
    >;

    const conditions: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (status) {
      conditions.push(`s.status = $${params.push(status)}`);
    }

    if (project_id) {
      if (!isValidUuid(project_id)) {
        respondValidationError(res, "project_id must be a valid UUID", "project_id");
        return;
      }
      conditions.push(`s.project_id = $${params.push(project_id)}`);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const parsedLimit = Number.parseInt(limit, 10);
    const parsedOffset = Number.parseInt(offset, 10);
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;
    const safeOffset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

    const { rows: countRows } = await pool.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM surveys s ${where}`,
      params,
    );

    params.push(safeLimit, safeOffset);

    const { rows } = await pool.query(
      `SELECT
         s.id::text,
         s.project_name,
         s.project_id::text,
         s.category_id::text,
         s.category_name,
         s.inspector_name,
         s.site_name,
         s.site_address,
         s.latitude,
         s.longitude,
         s.gps_accuracy,
         s.survey_date,
         s.status,
         s.notes,
         s.created_at,
         s.updated_at,
         (SELECT COUNT(*)::int FROM checklist_items c WHERE c.survey_id = s.id) AS checklist_count,
         (SELECT COUNT(*)::int FROM survey_photos p WHERE p.survey_id = s.id) AS photo_count
       FROM surveys s
       ${where}
       ORDER BY s.updated_at DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    res.json({
      surveys: rows,
      total: countRows[0]?.total ?? 0,
    });
  } catch (err) {
    console.error("GET /api/surveys/admin/surveys error:", err);
    res.status(500).json({ error: "Failed to retrieve admin survey list" });
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    await ensureSurveySoftDeleteColumn();
    const {
      project_id,
      status,
      category_id,
      limit = "100",
      offset = "0",
    } = req.query as Record<string, string>;

    const conditions: string[] = ["s.deleted_at IS NULL"];
    const params: unknown[] = [];

    if (project_id) {
      conditions.push(`s.project_id  = $${params.push(project_id)}`);
    }
    if (status) {
      conditions.push(`s.status       = $${params.push(status)}`);
    }
    if (category_id) {
      conditions.push(`s.category_id  = $${params.push(category_id)}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const lim = Math.min(parseInt(limit, 10), 500);
    const off = parseInt(offset, 10);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM surveys s ${where}`,
      params,
    );

    params.push(lim, off);

    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.project_name,
         s.category_name,
         COALESCE(cat.name, s.category_name) AS resolved_category,
         s.inspector_name,
         s.site_name,
         s.site_address,
         s.latitude,
         s.longitude,
         s.survey_date,
         s.status,
         s.notes,
         s.created_at,
         s.updated_at,
         (SELECT COUNT(*)::int FROM checklist_items c WHERE c.survey_id = s.id) AS checklist_count,
         (SELECT COUNT(*)::int FROM survey_photos   p WHERE p.survey_id = s.id) AS photo_count
       FROM surveys s
       LEFT JOIN categories cat ON cat.id = s.category_id
       ${where}
       ORDER BY s.survey_date DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    res.json({ surveys: rows, total: countRows[0].total });
  } catch (err) {
    console.error("GET /api/surveys error:", err);
    res.status(500).json({ error: "Failed to retrieve surveys" });
  }
});

router.get("/:id/report", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  try {
    const survey = await fetchSurveyFull(req.params.id);
    if (!survey) {
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    const report = generateReport(survey as any);
    const format = (req.query["format"] as string | undefined)?.toLowerCase();

    if (format === "markdown") {
      const md = toMarkdown(report);
      const filename = `engineering-report-${req.params.id}-${Date.now()}.md`;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.send(md);
      return;
    }

    res.json(report);
  } catch (err) {
    console.error("GET /api/surveys/:id/report error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

router.delete("/:id/report", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  try {
    const survey = await fetchSurveyFull(req.params.id);
    if (!survey) {
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    res.json({ message: "Report cleared" });
  } catch (err) {
    console.error("DELETE /api/surveys/:id/report error:", err);
    res.status(500).json({ error: "Failed to delete report" });
  }
});

async function mapSurveyPhotosWithRemoteUrls(
  photos: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (photos.length === 0) return photos;

  if (!process.env.STORAGE_BACKEND || process.env.STORAGE_BACKEND === "local") {
    return photos.map((photo) => {
      const filePath =
        typeof photo.file_path === "string" ? (photo.file_path as string) : "";
      const remoteUrl = filePath.startsWith("http")
        ? filePath
        : filePath.startsWith("/")
          ? filePath
          : `/uploads/${filePath}`;

      return { ...photo, remote_url: remoteUrl };
    });
  }

  return photos.map((photo) => {
    const filePath =
      typeof photo.file_path === "string" ? (photo.file_path as string) : "";
    return {
      ...photo,
      remote_url: filePath,
      signed_url: filePath,
    };
  });
}

function requireSurveyReadAccess(req: Request, res: Response): boolean {
  const role = req.authUser?.role;
  if (role === "admin" || role === "user") {
    return true;
  }

  res.status(403).json({ error: "Forbidden" });
  return false;
}

/** GET /api/surveys/:id */
router.get("/:id", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  if (!requireSurveyReadAccess(req, res)) return;

  try {
    const survey = await fetchSurveyFull(req.params.id);
    if (!survey) {
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    const normalizedPhotos = await mapSurveyPhotosWithRemoteUrls(
      (survey.photos as Array<Record<string, unknown>>) ?? [],
    );

    res.json({
      ...survey,
      photos: normalizedPhotos,
    });
  } catch (err) {
    console.error("GET /api/surveys/:id error:", err);
    res.status(500).json({ error: "Failed to retrieve survey" });
  }
});

/**
 * POST /api/surveys
 *
 * Accepts location as either:
 *   { "location": { "type": "Point", "coordinates": [lon, lat] } }
 * or flat fields:
 *   { "latitude": 51.5, "longitude": -0.1, "gps_accuracy": 5 }
 *
 * The geography column is populated with:
 *   ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
 */
router.post("/", async (req: Request, res: Response) => {
  const body = req.body as SurveyInput & { id?: string };

  if (body.id && !isValidUuid(body.id)) {
    respondValidationError(res, "id must be a valid UUID", "id");
    return;
  }

  if (
    !body.project_name?.trim() ||
    !body.inspector_name?.trim() ||
    !body.site_name?.trim()
  ) {
    res.status(400).json({
      error: "project_name, inspector_name, and site_name are required",
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const normalizedProjectId = await resolveExistingProjectId(
      client,
      body.project_id,
    );
    const normalizedCategoryId = await resolveExistingCategoryId(
      client,
      body.category_id,
    );
    const normalizedCategoryName = normalizeCategoryName(
      body.category_id,
      body.category_name,
    );

    // Allow the client to supply an ID (for offline-first mobile sync)
    const { rows: idRows } = await client.query(
      "SELECT gen_random_uuid() AS id",
    );
    const surveyId: string = body.id ?? (idRows[0].id as string);

    const coords = extractCoords(body);

    // Build parameterised values list
    const insertParams: unknown[] = [
      surveyId,
      body.project_name.trim(),
      normalizedProjectId,
      normalizedCategoryId,
      normalizedCategoryName,
      body.inspector_name.trim(),
      body.site_name.trim(),
      body.site_address ?? null,
      coords?.lat ?? null, // $9  — latitude  column
      coords?.lon ?? null, // $10 — longitude column
      coords?.accuracy ?? null, // $11 — gps_accuracy column
    ];

    // $12 onwards: geography expression or NULL
    const locationSql = coords
      ? geoExpr(insertParams, coords.lon, coords.lat)
      : "NULL";

    insertParams.push(
      body.survey_date ? new Date(body.survey_date) : new Date(), // survey_date
      body.notes ?? null, // notes
      body.status ?? "draft", // status
      body.device_id ?? null, // device_id
      body.metadata != null ? JSON.stringify(body.metadata) : null, // metadata
      // F-06: Ownership routing claims from SolarPro handoff JWT
      body.solarpro_user_id ?? null,    // solarpro_user_id
      body.solarpro_project_id ?? null, // solarpro_project_id
      body.solarpro_email ?? null,      // solarpro_email
      body.solarpro_org_id ?? null,     // solarpro_org_id
        // F-14: track which authenticated user created this survey (safe deletion)
        req.authUser?.userId ?? null,     // submitted_by_user_id
    );

    // F-06: [SSO OWNER STORED] log — confirms ownership claims are being persisted
    if (body.solarpro_user_id) {
      console.log(
        `[SSO OWNER STORED] surveyId=${surveyId} solarpro_user_id=${body.solarpro_user_id} solarpro_project_id=${body.solarpro_project_id ?? 'null'}`,
      );
    }

    const { rows } = await client.query(
      `INSERT INTO surveys
         (id, project_name, project_id, category_id, category_name,
          inspector_name, site_name, site_address,
          latitude, longitude, gps_accuracy, location,
          survey_date, notes, status, device_id, metadata,
          solarpro_user_id, solarpro_project_id, solarpro_email, solarpro_org_id,
          submitted_by_user_id)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          ${locationSql},
          $${insertParams.length - 9},
          $${insertParams.length - 8},
          $${insertParams.length - 7},
          $${insertParams.length - 6},
          $${insertParams.length - 5},
          $${insertParams.length - 4},
          $${insertParams.length - 3},
          $${insertParams.length - 2},
          $${insertParams.length - 1},
          $${insertParams.length})
       ON CONFLICT (id) DO UPDATE SET
         project_name = EXCLUDED.project_name,
         project_id = EXCLUDED.project_id,
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         inspector_name = EXCLUDED.inspector_name,
         site_name = EXCLUDED.site_name,
         site_address = EXCLUDED.site_address,
         latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude,
         gps_accuracy = EXCLUDED.gps_accuracy,
         location = EXCLUDED.location,
         survey_date = EXCLUDED.survey_date,
         notes = EXCLUDED.notes,
         status = EXCLUDED.status,
         device_id = EXCLUDED.device_id,
         metadata = EXCLUDED.metadata,
         solarpro_user_id    = COALESCE(EXCLUDED.solarpro_user_id,    surveys.solarpro_user_id),
         solarpro_project_id = COALESCE(EXCLUDED.solarpro_project_id, surveys.solarpro_project_id),
         solarpro_email      = COALESCE(EXCLUDED.solarpro_email,      surveys.solarpro_email),
         solarpro_org_id     = COALESCE(EXCLUDED.solarpro_org_id,     surveys.solarpro_org_id),
         submitted_by_user_id = COALESCE(surveys.submitted_by_user_id, EXCLUDED.submitted_by_user_id),
         updated_at = NOW()
       RETURNING id`,
      insertParams,
    );

    const newId = rows[0].id as string;

    if (body.checklist?.length)
      await upsertChecklist(client, newId, body.checklist);
    if (body.photos?.length) await upsertPhotos(client, newId, body.photos);

    await client.query("COMMIT");

    const full = await fetchSurveyFull(newId);
    broadcastSurveyEvent("survey.created", full);
    res.status(201).json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/surveys error:", err);
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: "Failed to create survey",
      details: message,
    });
  } finally {
    client.release();
  }
});

// ================================================================
// UPDATE SURVEY
// ================================================================

/** PUT /api/surveys/:id */
router.put("/:id", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  const { id } = req.params;
  const body = req.body as Partial<SurveyInput>;

  await ensureSurveySoftDeleteColumn();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      "SELECT id FROM surveys WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    if (existing.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    const coords = extractCoords(body as SurveyInput);
    const normalizedProjectId = await resolveExistingProjectId(
      client,
      body.project_id,
    );
    const normalizedCategoryId = await resolveExistingCategoryId(
      client,
      body.category_id,
    );
    const normalizedCategoryName = normalizeCategoryName(
      body.category_id,
      body.category_name,
    );

    const updateParams: unknown[] = [
      id,
      body.project_name ?? null,
      normalizedProjectId,
      normalizedCategoryId,
      normalizedCategoryName,
      body.inspector_name ?? null,
      body.site_name ?? null,
      body.site_address ?? null,
      coords?.lat ?? null, // $9
      coords?.lon ?? null, // $10
      coords?.accuracy ?? null, // $11
    ];

    // Keep existing location when no new coords are supplied
    const locationSql = coords
      ? geoExpr(updateParams, coords.lon, coords.lat)
      : "location";

    updateParams.push(
      body.notes ?? null,
      body.status ?? null,
      body.metadata != null ? JSON.stringify(body.metadata) : null,
    );

    await client.query(
      `UPDATE surveys SET
         project_name   = COALESCE($2,  project_name),
         project_id     = COALESCE($3,  project_id),
         category_id    = COALESCE($4,  category_id),
         category_name  = COALESCE($5,  category_name),
         inspector_name = COALESCE($6,  inspector_name),
         site_name      = COALESCE($7,  site_name),
         site_address   = COALESCE($8,  site_address),
         latitude       = COALESCE($9,  latitude),
         longitude      = COALESCE($10, longitude),
         gps_accuracy   = COALESCE($11, gps_accuracy),
         location       = ${locationSql},
         notes          = COALESCE($${updateParams.length - 2}, notes),
         status         = COALESCE($${updateParams.length - 1}, status),
         metadata       = COALESCE($${updateParams.length}::jsonb, metadata),
         updated_at     = NOW()
       WHERE id = $1`,
      updateParams,
    );

    if (body.checklist?.length)
      await upsertChecklist(client, id, body.checklist);
    if (body.photos?.length) await upsertPhotos(client, id, body.photos);

    await client.query("COMMIT");

    const full = await fetchSurveyFull(id);
    broadcastSurveyEvent("survey.updated", full);
    res.json(full);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PUT /api/surveys/:id error:", err);
    res.status(500).json({ error: "Failed to update survey" });
  } finally {
    client.release();
  }
});

// ================================================================
// PHOTO UPLOAD  (multipart/form-data from mobile)
// ================================================================

/**
 * POST /api/surveys/:id/photos
 *
 * Accepts one or more image files as multipart/form-data.
 * Field names: "photos" (multiple) or "photo" (single).
 * Optional body fields per file: label, captured_at
 */
router.post(
  "/:id/photos",
  upload.array("photos", 20),
  async (req: Request, res: Response) => {
    if (!requireUuidParam(req, res, "id")) return;
    const { id } = req.params;

    // Verify the survey exists
    const { rows } = await pool.query("SELECT id FROM surveys WHERE id = $1", [
      id,
    ]);
    if (rows.length === 0) {
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No image files provided" });
      return;
    }

    // Labels may be passed as a JSON array string or a single string
    let labels: string[] = [];
    try {
      if (req.body.labels) {
        labels = JSON.parse(req.body.labels as string);
      } else if (req.body.label) {
        labels = [req.body.label as string];
      }
    } catch {
      /* ignore parse errors */
    }

    const captured_at = req.body.captured_at
      ? new Date(req.body.captured_at as string)
      : new Date();

    const inserted: unknown[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const label = labels[i] ?? file.originalname ?? "";

      // Upload buffer to storage backend (local disk or S3)
      const ext = path.extname(file.originalname) || ".jpg";
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const storedPath = await uploadFile(file.buffer, filename, file.mimetype);

      const { rows: photoRows } = await pool.query(
        `INSERT INTO survey_photos
         (survey_id, filename, label, file_path, mime_type, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
        [
          id,
          file.originalname,
          label,
          storedPath, // URL returned by storageClient (local path or S3 presigned URL)
          file.mimetype,
          captured_at,
        ],
      );
      inserted.push(photoRows[0]);
    }

    res.status(201).json({ uploaded: inserted.length, photos: inserted });
  },
);

/**
 * POST /api/surveys/:id/photos/:photoId/infer
 *
 * Runs Roboflow inference against a stored survey photo.
 * Uses `file_path` when available and falls back to base64 `data_url`.
 *
 * Optional body:
 *   {
 *     model_id?: string,
 *     confidence?: number,
 *     overlap?: number,
 *     elec_classes?: string[],
 *     material_classes?: string[]
 *   }
 */
router.post(
  "/:id/photos/:photoId/infer",
  async (req: Request, res: Response) => {
    if (!requireUuidParam(req, res, "id")) return;
    if (!requireUuidParam(req, res, "photoId")) return;
    const { id, photoId } = req.params;
    const { model_id, confidence, overlap, elec_classes, material_classes } =
      req.body as {
        model_id?: string;
        confidence?: number;
        overlap?: number;
        elec_classes?: string[];
        material_classes?: string[];
      };

    if (
      confidence !== undefined &&
      (typeof confidence !== "number" || confidence < 0 || confidence > 100)
    ) {
      res
        .status(400)
        .json({ error: "`confidence` must be a number between 0 and 100" });
      return;
    }
    if (
      overlap !== undefined &&
      (typeof overlap !== "number" || overlap < 0 || overlap > 100)
    ) {
      res
        .status(400)
        .json({ error: "`overlap` must be a number between 0 and 100" });
      return;
    }

    if (
      elec_classes !== undefined &&
      (!Array.isArray(elec_classes) ||
        elec_classes.some((v) => typeof v !== "string" || !v.trim()))
    ) {
      res.status(400).json({
        error:
          "`elec_classes` must be an array of non-empty class-name strings",
      });
      return;
    }

    if (
      material_classes !== undefined &&
      (!Array.isArray(material_classes) ||
        material_classes.some((v) => typeof v !== "string" || !v.trim()))
    ) {
      res.status(400).json({
        error:
          "`material_classes` must be an array of non-empty class-name strings",
      });
      return;
    }

    const { rows } = await pool.query(
      `SELECT id, file_path, data_url
     FROM survey_photos
     WHERE id = $1 AND survey_id = $2`,
      [photoId, id],
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "Photo not found for this survey" });
      return;
    }

    const photo = rows[0] as {
      file_path?: string | null;
      data_url?: string | null;
    };

    try {
      const inferenceResult = photo.file_path
        ? await inferRoboflowFromPath(photo.file_path, {
            modelId: model_id,
            confidence,
            overlap,
            elecClasses: elec_classes,
            materialClasses: material_classes,
          })
        : photo.data_url
          ? await inferRoboflowFromBuffer(dataUrlToBuffer(photo.data_url), {
              modelId: model_id,
              confidence,
              overlap,
              elecClasses: elec_classes,
              materialClasses: material_classes,
            })
          : null;

      if (!inferenceResult) {
        res
          .status(400)
          .json({ error: "Photo has neither file_path nor data_url" });
        return;
      }

      const resolvedModelId = model_id ?? process.env.ROBOFLOW_MODEL_ID ?? null;

      try {
        await insertInferenceLog({
          surveyId: id,
          photoId,
          modelId: resolvedModelId,
          options: {
            confidence,
            overlap,
            elec_classes,
            material_classes,
          },
          inference: inferenceResult,
        });
      } catch (logError) {
        // Keep inference API available even if telemetry persistence fails.
        console.error(
          "POST /api/surveys/:id/photos/:photoId/infer log write error:",
          logError,
        );
      }

      res.status(200).json({
        survey_id: id,
        photo_id: photoId,
        model_id: resolvedModelId,
        inference: inferenceResult,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Roboflow error";
      console.error(
        "POST /api/surveys/:id/photos/:photoId/infer error:",
        error,
      );
      res.status(502).json({ error: message });
    }
  },
);

/**
 * GET /api/surveys/inference-logs/recent
 *
 * Admin-only telemetry view over recent stored inference results.
 * Query params:
 *   limit?: number       default 25, max 100
 *   survey_id?: string   filter by survey
 *   photo_id?: string    filter by photo
 *   model_id?: string    filter by model
 *   include_inference?: boolean  when true include raw inference JSON
 */
router.get("/inference-logs/recent", async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    await ensureInferenceLogsTable();

    const {
      limit = "25",
      survey_id,
      photo_id,
      model_id,
      include_inference,
    } = req.query as Record<string, string | undefined>;

    const parsedLimit = Number.parseInt(limit, 10);
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 25;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (survey_id) {
      conditions.push(`logs.survey_id = $${params.push(survey_id)}`);
    }
    if (photo_id) {
      conditions.push(`logs.photo_id = $${params.push(photo_id)}`);
    }
    if (model_id) {
      conditions.push(`logs.model_id = $${params.push(model_id)}`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const includeInference = include_inference === "true";

    params.push(safeLimit);

    const { rows } = await pool.query(
      `SELECT
         logs.id,
         logs.survey_id,
         logs.photo_id,
         logs.model_id,
         logs.request_options,
         logs.prediction_count,
         logs.created_at,
         surveys.project_name,
         surveys.site_name,
         photos.label AS photo_label,
         ${includeInference ? "logs.inference" : "NULL::jsonb AS inference"}
       FROM photo_inference_logs logs
       JOIN surveys ON surveys.id = logs.survey_id
       JOIN survey_photos photos ON photos.id = logs.photo_id
       ${where}
       ORDER BY logs.created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    res.json({
      logs: rows,
      total: rows.length,
      filters: {
        survey_id: survey_id ?? null,
        photo_id: photo_id ?? null,
        model_id: model_id ?? null,
        include_inference: includeInference,
        limit: safeLimit,
      },
    });
  } catch (error) {
    console.error("GET /api/surveys/inference-logs/recent error:", error);
    res.status(500).json({ error: "Failed to retrieve inference telemetry" });
  }
});

// ----------------------------------------------------------------
// POST /api/surveys/:id/ar-detection
//
// Stores a structured AR detection payload from the mobile app.
// Each item in `electrical` carries a ByteTracker-assigned track_id
// so the same physical object (MSP, meter, …) keeps a stable AR tag
// even when the camera pans away and returns.
// `exterior` holds structural/exterior detections (roof, conduit, etc.).
// `distances` holds depth-anchored spatial readings from the Depth
// Estimation model so AR labels are pinned to the panel surface.
// When a main service panel is detected the survey is automatically
// escalated to "submitted" (Ready for Engineering) and a pass-status
// checklist item is appended.
// ----------------------------------------------------------------
interface ARElectricalDetection {
  class: string;
  confidence: number;
  track_id: number;
  depth_m?: number;
  ar_label?: string;
}

interface ARExteriorDetection {
  class: string;
  confidence: number;
  track_id: number;
  depth_m?: number;
  ar_label?: string;
}

interface ARDetectionBody {
  project_id?: string;
  electrical: ARElectricalDetection[];
  exterior?: ARExteriorDetection[];
  distances?: Record<string, string>;
  track_ids?: number[];
  measurements?: Record<string, string>;
  roof_type?: string;
  /** ISO-8601 client-side capture time; stored as detected_at. Defaults to NOW(). */
  timestamp?: string;
}

/**
 * Escalates the survey to "submitted" status and appends a pass-status
 * checklist item so the engineering pipeline can pick it up.
 * Called when a Main Service Panel is detected in the AR session.
 */
async function triggerPipeline(surveyId: string, event: string): Promise<void> {
  await pool.query(
    `UPDATE surveys SET status = 'submitted', updated_at = NOW()
     WHERE id = $1 AND status = 'draft'`,
    [surveyId],
  );

  await pool.query(
    `INSERT INTO checklist_items (survey_id, label, status, notes, sort_order)
     SELECT $1::uuid, $2::text, 'pass', $3::text,
            COALESCE((SELECT MAX(sort_order) + 1 FROM checklist_items WHERE survey_id = $1::uuid), 0)
     WHERE NOT EXISTS (
       SELECT 1 FROM checklist_items WHERE survey_id = $1::uuid AND label = $2::text
     )`,
    [
      surveyId,
      "MSP Detected — Ready for Engineering",
      `AR pipeline event: ${event}`,
    ],
  );
}

router.post("/:id/ar-detection", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  const { id } = req.params;
  const body = req.body as ARDetectionBody;

  // --- input validation ---
  if (!Array.isArray(body.electrical) || body.electrical.length === 0) {
    res.status(400).json({ error: "`electrical` must be a non-empty array" });
    return;
  }

  for (const item of body.electrical) {
    if (typeof item.class !== "string" || !item.class) {
      res
        .status(400)
        .json({ error: "Each detection must have a `class` string" });
      return;
    }
    if (
      typeof item.confidence !== "number" ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      res
        .status(400)
        .json({ error: "`confidence` must be a number between 0 and 1" });

      return;
    }
    if (typeof item.track_id !== "number" || !Number.isInteger(item.track_id)) {
      res.status(400).json({ error: "`track_id` must be an integer" });
      return;
    }
  }

  if (
    body.measurements !== undefined &&
    (typeof body.measurements !== "object" || Array.isArray(body.measurements))
  ) {
    res
      .status(400)
      .json({ error: "`measurements` must be a key/value object" });
    return;
  }

  if (
    body.distances !== undefined &&
    (typeof body.distances !== "object" || Array.isArray(body.distances))
  ) {
    res.status(400).json({ error: "`distances` must be a key/value object" });
    return;
  }

  if (
    body.track_ids !== undefined &&
    (!Array.isArray(body.track_ids) ||
      body.track_ids.some((t) => typeof t !== "number" || !Number.isInteger(t)))
  ) {
    res
      .status(400)
      .json({ error: "`track_ids` must be an array of integers" });
    return;
  }

  // validate optional ISO timestamp
  let detectedAt: Date | null = null;
  if (body.timestamp !== undefined) {
    detectedAt = new Date(body.timestamp);
    if (isNaN(detectedAt.getTime())) {
      res
        .status(400)
        .json({ error: "`timestamp` must be a valid ISO-8601 date string" });
      return;
    }
  }

  // --- verify survey exists ---
  const { rows: surveyRows } = await pool.query(
    "SELECT id FROM surveys WHERE id = $1",
    [id],
  );
  if (surveyRows.length === 0) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  // --- derive track_ids: use explicit list if provided, else union from electrical + exterior ---
  const resolvedTrackIds: number[] =
    body.track_ids ??
    [
      ...body.electrical.map((d) => d.track_id),
      ...(body.exterior ?? []).map((d) => d.track_id),
    ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  // --- persist detection ---
  await pool.query(
    `INSERT INTO ar_detections
       (survey_id, project_id, electrical, exterior, distances, track_ids,
        measurements, roof_type, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      body.project_id ?? null,
      JSON.stringify(body.electrical),
      JSON.stringify(body.exterior ?? []),
      JSON.stringify(body.distances ?? {}),
      JSON.stringify(resolvedTrackIds),
      JSON.stringify(body.measurements ?? {}),
      body.roof_type ?? null,
      detectedAt ?? new Date(),
    ],
  );

  // --- tag MSP and trigger engineering pipeline ---
  const hasPanel = body.electrical.some((det) => det.class === "panel");
  if (hasPanel) {
    await triggerPipeline(id, "electrical_detected");
  }

  res
    .status(200)
    .json({ status: "success", message: "AR data synced to pipeline" });
});

// ----------------------------------------------------------------
// GET /api/surveys/:id/ar-detections
//
// Returns all AR detection records for a survey, ordered newest-first.
// ----------------------------------------------------------------
router.get("/:id/ar-detections", async (req: Request, res: Response) => {
  const { id } = req.params;

  const { rows: surveyRows } = await pool.query(
    "SELECT id FROM surveys WHERE id = $1",
    [id],
  );
  if (surveyRows.length === 0) {
    res.status(404).json({ error: "Survey not found" });
    return;
  }

  const { rows } = await pool.query(
    `SELECT id, survey_id, project_id, electrical, exterior, distances,
            measurements, roof_type, detected_at
     FROM ar_detections
     WHERE survey_id = $1
     ORDER BY detected_at DESC`,
    [id],
  );

  res.json({ detections: rows, total: rows.length });
});

/** DELETE /api/surveys/:id */
router.delete("/:id", async (req: Request, res: Response) => {
  if (!requireUuidParam(req, res, "id")) return;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await ensureSurveySoftDeleteColumn();
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      "SELECT id FROM surveys WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    if (existing.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Survey not found" });
      return;
    }

    await client.query(
      `UPDATE surveys
          SET deleted_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [id],
    );

    await client.query("COMMIT");

    await softDeleteSurveyAndQueueCleanup(id);

    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DELETE /api/surveys/:id error:", err);
    res.status(500).json({ error: "Failed to delete survey" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/surveys/diagnostics/schema
 *
 * Returns the health status of the surveys route and schema readiness
 * for production. Checks essential columns exist in the surveys table.
 */
router.get("/diagnostics/schema", async (_req: Request, res: Response) => {
  try {
    await ensureSurveySoftDeleteColumn();

    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
    }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'surveys'
          AND column_name IN ('project_id', 'category_id', 'category_name', 'metadata', 'deleted_at')
        ORDER BY column_name`,
    );

    res.json({
      ok: true,
      columns: rows,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

export { ensureSurveySoftDeleteColumn };
export default router;
