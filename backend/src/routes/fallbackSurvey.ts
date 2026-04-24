import { Router, Request, Response } from "express";
import { consumeJti } from "../services/tokenReplay";
import jwt, { JwtPayload } from "jsonwebtoken";
import { pool } from "../database";

const router = Router();

type HandoffClaims = JwtPayload & {
  jti?: string;
  project_id?: string;
  project_name?: string;
  site_name?: string;
  site_address?: string;
  inspector_name?: string;
  category_id?: string;
  category_name?: string;
  notes?: string;
  latitude?: number;
  longitude?: number;
  gps_accuracy?: number;
  metadata?: unknown;
};

// used_handoff_tokens is managed by ../services/tokenReplay.ts
// Use consumeJti() for all replay protection — do NOT touch the table directly.

let fallbackTableReady: Promise<void> | null = null;

async function ensureFallbackSurveysTable(): Promise<void> {
  if (!fallbackTableReady) {
    fallbackTableReady = pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS fallback_surveys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          jti TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL,
          project_name TEXT,
          site_name TEXT,
          site_address TEXT,
          inspector_name TEXT,
          category_id TEXT,
          category_name TEXT,
          notes TEXT,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          gps_accuracy DOUBLE PRECISION,
          metadata JSONB,
          submitted_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'pending_partner_push',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        fallbackTableReady = null;
        throw error;
      });
  }

  await fallbackTableReady;
}

function getHandoffSecret(): string | null {
  const secret = process.env.SOLARPRO_HANDOFF_SECRET?.trim();
  return secret || null;
}

function verifyToken(rawToken: string, secret: string): HandoffClaims {
  const verified = jwt.verify(rawToken, secret, { algorithms: ["HS256"] });
  if (!verified || typeof verified !== "object") {
    throw new Error("Invalid handoff token");
  }

  const decoded = verified as HandoffClaims;
  if (!decoded.jti || !decoded.project_id) {
    throw new Error("Token missing required claims");
  }

  return decoded;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderFallbackForm(claims: HandoffClaims, token: string): string {
  const projectName = escapeHtml(claims.project_name ?? "");
  const siteName = escapeHtml(claims.site_name ?? "");
  const siteAddress = escapeHtml(claims.site_address ?? "");
  const inspectorName = escapeHtml(claims.inspector_name ?? "");
  const notes = escapeHtml(claims.notes ?? "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Survey Fallback Form</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f4f7fb; color: #111827; }
      .wrap { max-width: 760px; margin: 24px auto; padding: 0 14px 24px; }
      .card { background: #fff; border: 1px solid #dbe4f0; border-radius: 12px; padding: 16px; }
      h1 { margin: 0 0 8px; font-size: 26px; }
      p { margin: 0 0 14px; color: #4b5563; }
      label { display: block; margin: 10px 0 4px; font-size: 13px; color: #374151; font-weight: 600; }
      input, textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; font-size: 14px; box-sizing: border-box; }
      textarea { min-height: 110px; }
      button { margin-top: 14px; width: 100%; padding: 12px; border: none; border-radius: 8px; background: #2563eb; color: white; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .status { margin-top: 12px; font-size: 14px; }
      .ok { color: #166534; }
      .err { color: #b91c1c; }
      code { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 4px; padding: 1px 5px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Survey Capture Fallback</h1>
        <p>Partner app domain is unavailable. This fallback stores survey handoff payload in Postgres for later partner sync.</p>

        <form id="surveyForm">
          <input type="hidden" id="token" value="${escapeHtml(token)}" />
          <label>Project Name</label>
          <input id="project_name" value="${projectName}" />

          <label>Inspector Name</label>
          <input id="inspector_name" value="${inspectorName}" />

          <label>Site Name</label>
          <input id="site_name" value="${siteName}" />

          <label>Site Address</label>
          <input id="site_address" value="${siteAddress}" />

          <label>Notes</label>
          <textarea id="notes">${notes}</textarea>

          <button id="submitBtn" type="submit">Store Fallback Survey</button>
        </form>

        <div id="status" class="status"></div>
      </div>
    </div>

    <script>
      const form = document.getElementById('surveyForm');
      const statusEl = document.getElementById('status');
      const submitBtn = document.getElementById('submitBtn');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        statusEl.textContent = 'Submitting...';
        statusEl.className = 'status';
        submitBtn.disabled = true;

        const payload = {
          token: document.getElementById('token').value,
          project_name: document.getElementById('project_name').value,
          inspector_name: document.getElementById('inspector_name').value,
          site_name: document.getElementById('site_name').value,
          site_address: document.getElementById('site_address').value,
          notes: document.getElementById('notes').value,
        };

        try {
          const res = await fetch('/api/fallback-surveys/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(body.error?.message || body.error || 'Failed to store fallback survey');
          }

          statusEl.textContent = 'Stored successfully. Fallback survey ID: ' + body.id;
          statusEl.className = 'status ok';
          submitBtn.disabled = true;
        } catch (error) {
          statusEl.textContent = error instanceof Error ? error.message : String(error);
          statusEl.className = 'status err';
          submitBtn.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}

router.get("/new-survey-fallback", (req: Request, res: Response) => {
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      res.status(500).send("SOLARPRO_HANDOFF_SECRET is not configured");
      return;
    }

    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.status(400).send("Missing token query parameter");
      return;
    }

    const claims = verifyToken(token, secret);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderFallbackForm(claims, token));
  } catch (error) {
    res.status(401).send(
      error instanceof Error ? error.message : "Invalid or expired token",
    );
  }
});

router.post("/api/fallback-surveys/submit", async (req: Request, res: Response) => {
  try {
    const secret = getHandoffSecret();
    if (!secret) {
      res.status(500).json({
        error: {
          code: "SERVER_MISCONFIGURED",
          message: "SOLARPRO_HANDOFF_SECRET is not configured",
        },
      });
      return;
    }

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token) {
      res.status(400).json({
        error: { code: "VALIDATION_FAILED", message: "token is required" },
      });
      return;
    }

    const claims = verifyToken(token, secret);

    await ensureFallbackSurveysTable();

    const client = await pool.connect();
    try {
      // Consume jti via shared tokenReplay service (outside transaction — 
      // the unique constraint is the real guard; txn is for fallback_surveys insert).
      const replayResult = await consumeJti(claims.jti!, "fallback");
      if (replayResult === "replayed") {
        res.status(409).json({
          error: {
            code: "HANDOFF_TOKEN_REPLAYED",
            message: "This handoff token has already been used",
          },
        });
        return;
      }
      if (replayResult === "error") {
        throw new Error("tokenReplay DB error");
      }

      await client.query("BEGIN");

      const submittedFields = {
        project_name: req.body?.project_name ?? null,
        inspector_name: req.body?.inspector_name ?? null,
        site_name: req.body?.site_name ?? null,
        site_address: req.body?.site_address ?? null,
        notes: req.body?.notes ?? null,
      };

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fallback_surveys (
           jti, project_id, project_name, site_name, site_address,
           inspector_name, category_id, category_name, notes,
           latitude, longitude, gps_accuracy, metadata, submitted_fields
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb
         )
         RETURNING id::text`,
        [
          claims.jti,
          claims.project_id,
          claims.project_name ?? null,
          claims.site_name ?? null,
          claims.site_address ?? null,
          claims.inspector_name ?? null,
          claims.category_id ?? null,
          claims.category_name ?? null,
          claims.notes ?? null,
          typeof claims.latitude === "number" ? claims.latitude : null,
          typeof claims.longitude === "number" ? claims.longitude : null,
          typeof claims.gps_accuracy === "number" ? claims.gps_accuracy : null,
          JSON.stringify(claims.metadata ?? null),
          JSON.stringify(submittedFields),
        ],
      );

      await client.query("COMMIT");

      res.status(201).json({
        id: rows[0].id,
        status: "pending_partner_push",
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("POST /api/fallback-surveys/submit error:", error);
    res.status(500).json({
      error: {
        code: "FALLBACK_SUBMIT_FAILED",
        message: "Failed to store fallback survey",
      },
    });
  }
});

router.get("/api/fallback-surveys/projects", async (_req: Request, res: Response) => {
  try {
    await ensureFallbackSurveysTable();

    const { rows } = await pool.query(
      `SELECT
         id::text,
         project_id,
         project_name,
         site_name,
         site_address,
         inspector_name,
         category_id,
         category_name,
         notes,
         latitude,
         longitude,
         gps_accuracy,
         metadata,
         status,
         created_at::text
       FROM fallback_surveys
       ORDER BY created_at DESC
       LIMIT 500`,
    );

    res.json({
      projects: rows,
      total: rows.length,
    });
  } catch (error) {
    console.error("GET /api/fallback-surveys/projects error:", error);
    res.status(500).json({
      error: {
        code: "FALLBACK_PROJECTS_FAILED",
        message: "Failed to load fallback project templates",
      },
    });
  }
});

export default router;
