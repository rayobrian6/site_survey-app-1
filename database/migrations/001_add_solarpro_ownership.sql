-- F-06: Multi-Tenant Ownership Routing
-- Adds SolarPro ownership identity columns to the surveys table so each survey
-- can be traced back to the SolarPro user and project that initiated the handoff.

ALTER TABLE surveys ADD COLUMN IF NOT EXISTS solarpro_user_id    TEXT;
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS solarpro_project_id TEXT;
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS solarpro_email      TEXT;
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS solarpro_org_id     TEXT;

-- Indexes to support ownership-based queries from SolarPro ingest
CREATE INDEX IF NOT EXISTS idx_surveys_solarpro_user_id
    ON surveys(solarpro_user_id);

CREATE INDEX IF NOT EXISTS idx_surveys_solarpro_project_id
    ON surveys(solarpro_project_id);