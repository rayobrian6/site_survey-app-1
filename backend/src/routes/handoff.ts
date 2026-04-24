import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { incrementMetric } from "../services/metrics";
import { consumeJti } from "../services/tokenReplay";

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
  // F-06: Ownership routing claims — passed through to the mobile app so
  // it can send them back when creating the survey record (Phase 2b).
  solarpro_user_id?: string;
  solarpro_project_id?: string;
  solarpro_email?: string;
  solarpro_name?: string;
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

    const replayResult = await consumeJti(decoded.jti, "handoff");
    if (replayResult === "replayed") {
      incrementMetric("handoff_replay_total");
      res.status(409).json({
        error: {
          code: "HANDOFF_TOKEN_REPLAYED",
          message: "Handoff token has already been used",
        },
      });
      return;
    }
    if (replayResult === "error") {
      res.status(500).json({
        error: {
          code: "HANDOFF_FAILED",
          message: "Failed to validate handoff token (DB error)",
        },
      });
      return;
    }

    // F-06: [HANDOFF OWNER] log — confirms ownership claims arrived from SolarPro JWT
    if (decoded.solarpro_user_id) {
      console.log(
        `[HANDOFF OWNER] consumed jti=${decoded.jti} solarpro_user_id=${decoded.solarpro_user_id} solarpro_project_id=${decoded.solarpro_project_id ?? 'null'}`,
      );
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
      // F-06: Ownership routing — mobile app stores these on the survey record
      // so the webhook payload carries them back to SolarPro for owner resolution.
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
