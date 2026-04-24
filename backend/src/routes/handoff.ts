import { Router, Request, Response } from "express";
import { pool } from "../database";
import jwt, { JwtPayload } from "jsonwebtoken";
import { incrementMetric } from "../services/metrics";

const router = Router();

let usedTokensTableReady: Promise<void> | null = null;

async function ensureUsedTokensTable(): Promise<void> {
  if (!usedTokensTableReady) {
    usedTokensTableReady = pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS used_handoff_tokens (
          jti TEXT PRIMARY KEY,
          used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        usedTokensTableReady = null;
        throw error;
      });
  }

  await usedTokensTableReady;
}

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

router.get("/:token", async (req: Request, res: Response) => {
  try {
    const secret = process.env.SOLARPRO_HANDOFF_SECRET;
    if (!secret) {
      res.status(500).json({
        error: {
          code: "SERVER_MISCONFIGURED",
          message: "SOLARPRO_HANDOFF_SECRET is not configured",
        },
      });
      return;
    }

    const rawToken = req.params.token;
    let decoded: HandoffClaims;

    try {
      const verified = jwt.verify(rawToken, secret, {
        algorithms: ["HS256"],
      });

      if (!verified || typeof verified !== "object") {
        res.status(401).json({
          error: {
            code: "INVALID_HANDOFF_TOKEN",
            message: "Invalid handoff token",
          },
        });
        return;
      }

      decoded = verified as HandoffClaims;
    } catch {
      res.status(401).json({
        error: {
          code: "INVALID_HANDOFF_TOKEN",
          message: "Invalid or expired handoff token",
        },
      });
      return;
    }

    if (!decoded.jti) {
      res.status(422).json({
        error: {
          code: "VALIDATION_FAILED",
          message: "handoff token is missing jti",
          field: "jti",
        },
      });
      return;
    }

    if (!decoded.project_id) {
      res.status(422).json({
        error: {
          code: "VALIDATION_FAILED",
          message: "handoff token is missing project_id",
          field: "project_id",
        },
      });
      return;
    }

    await ensureUsedTokensTable();

    try {
      await pool.query(`INSERT INTO used_handoff_tokens (jti) VALUES ($1)`, [
        decoded.jti,
      ]);
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === "23505") {
        incrementMetric("handoff_replay_total");
        res.status(409).json({
          error: {
            code: "HANDOFF_TOKEN_REPLAYED",
            message: "Handoff token has already been used",
          },
        });
        return;
      }
      throw error;
    }

    if (decoded.solarpro_user_id) {
      console.log("[HANDOFF OWNER]", {
        solarpro_user_id: decoded.solarpro_user_id,
        solarpro_project_id: decoded.solarpro_project_id,
        solarpro_email: decoded.solarpro_email,
        jti: decoded.jti,
      });
    }

    res.json({
      project_id: decoded.project_id,
      project_name: decoded.project_name ?? null,
      site_name: decoded.site_name ?? null,
      site_address: decoded.site_address ?? null,
      inspector_name: decoded.inspector_name ?? null,
      category_id: decoded.category_id ?? null,
      category_name: decoded.category_name ?? null,
      notes: decoded.notes ?? null,
      latitude: typeof decoded.latitude === "number" ? decoded.latitude : null,
      longitude:
        typeof decoded.longitude === "number" ? decoded.longitude : null,
      gps_accuracy:
        typeof decoded.gps_accuracy === "number" ? decoded.gps_accuracy : null,
      metadata: decoded.metadata ?? null,
      // F-06 ownership claims
      solarpro_user_id: decoded.solarpro_user_id ?? null,
      solarpro_project_id: decoded.solarpro_project_id ?? null,
      solarpro_email: decoded.solarpro_email ?? null,
    });
  } catch (error) {
    console.error("GET /api/handoff/:token error:", error);
    res.status(500).json({
      error: {
        code: "HANDOFF_FAILED",
        message: "Failed to process handoff token",
      },
    });
  }
});

export default router;
