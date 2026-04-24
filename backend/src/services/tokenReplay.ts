// ============================================================================
// tokenReplay.ts — Shared handoff token replay protection service
//
// Consolidates used_handoff_tokens table management into a single module.
//
// Previously, both handoff.ts and fallbackSurvey.ts independently managed
// their own CREATE TABLE IF NOT EXISTS calls and usedTokensTableReady promises.
// This worked by coincidence (same physical table) but created a split-brain
// risk in horizontal scaling scenarios.
//
// This service is the SINGLE owner of used_handoff_tokens. Both routers call
// consumeJti() and never touch the table directly.
//
// consumeJti() semantics:
//   - 'ok'       → jti was new; caller proceeds normally
//   - 'replayed' → jti was already in the table; caller returns 409
//   - 'error'    → DB error; caller returns 500
// ============================================================================

import { pool } from '../database';

export type ConsumeJtiResult = 'ok' | 'replayed' | 'error';

export type ConsumedBy = 'handoff' | 'fallback';

let tableReady: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = pool
      .query(
        `
        CREATE TABLE IF NOT EXISTS used_handoff_tokens (
          jti        TEXT        PRIMARY KEY,
          consumed_by TEXT       NOT NULL DEFAULT 'handoff',
          used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `,
      )
      .then(() => undefined)
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  await tableReady;
}

/**
 * Attempt to mark a jti as consumed.
 *
 * Returns:
 *   'ok'       — jti was inserted successfully (first use)
 *   'replayed' — jti already exists (duplicate use / replay attack)
 *   'error'    — DB error during insert
 *
 * Never throws.
 */
export async function consumeJti(
  jti: string,
  consumedBy: ConsumedBy = 'handoff',
): Promise<ConsumeJtiResult> {
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO used_handoff_tokens (jti, consumed_by) VALUES ($1, $2)`,
      [jti, consumedBy],
    );
    return 'ok';
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === '23505') {
      // Unique constraint violation — jti already used
      return 'replayed';
    }
    console.error('[tokenReplay] consumeJti DB error:', error);
    return 'error';
  }
}