// The Medicost Postgres schema.
//
// Design philosophy: store the source losslessly, derive everything else at read
// time. Hospital price files (CMS v3.0.0 machine-readable files) are the ground
// truth and are expensive to re-acquire, so we never drop or collapse a field on
// ingest. We normalize the SHAPE (unpivot the "wide" CSVs' payer columns into
// rows; split a procedure's 1–4 codes into a child table) but preserve the
// CONTENT. Lossy/derived decisions — "lowest cost", percentage→dollar — live in
// QUERIES (see the cheapest_charges view), never in stored values.
//
// Grain:
//   hospital            — one per facility (DOH fac_id)
//   payer (+ plan)      — one per (payer_name, plan_name)
//   procedure           — one distinct (hospital, description, setting, modifiers,
//                         drug unit/type) item; carries the payer-less charges
//                         (gross / discounted_cash / min / max)
//   procedure_code      — 1..N billing codes for a procedure (CPT, HCPCS, RC, ...)
//   charge              — one payer/plan's negotiated rate for a procedure
//                         (dollar OR percentage OR algorithm, kept raw + separate)
//
// Safe to re-run (IF NOT EXISTS). Per-hospital ingest is idempotent: a re-ingest
// deletes that hospital's procedures (cascading to codes+charges) and reloads.

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS hospitals (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fac_id        TEXT UNIQUE,                 -- NYS DOH facility id (registry key)
  name          TEXT NOT NULL UNIQUE,
  borough       TEXT,
  city          TEXT,
  state         TEXT DEFAULT 'NY',
  zip           TEXT,
  source_url    TEXT,                        -- the mrf-url actually ingested
  last_ingested TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payers (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT NOT NULL,
  plan_name TEXT,
  UNIQUE (name, plan_name)
);

-- One distinct procedure per hospital. Holds the descriptive fields and the
-- payer-LESS standard charges (these are per-procedure, not per-payer).
CREATE TABLE IF NOT EXISTS procedures (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hospital_id           INTEGER NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  description           TEXT,
  setting               TEXT,                -- inpatient | outpatient | both
  modifiers             TEXT,
  drug_unit             TEXT,                -- drug_unit_of_measurement
  drug_type             TEXT,                -- drug_type_of_measurement
  gross_charge          DOUBLE PRECISION,    -- standard_charge|gross
  discounted_cash_price DOUBLE PRECISION,    -- standard_charge|discounted_cash
  min_negotiated_rate   DOUBLE PRECISION,    -- standard_charge|min  (across payers)
  max_negotiated_rate   DOUBLE PRECISION,    -- standard_charge|max
  generic_notes         TEXT                 -- additional_generic_notes
);

-- A procedure carries 1..N codes (CPT, HCPCS, MS-DRG, RC, NDC, LOCAL, ...).
-- Child table so search-by-any-code works (don't pick a single "primary" code).
CREATE TABLE IF NOT EXISTS procedure_codes (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  code_type    TEXT
);

-- One payer/plan's negotiated rate for a procedure. The rate is stored RAW as
-- exactly one of dollar / percentage / algorithm (whichever the file gave) —
-- never collapsed. estimated_dollar is left to query time (see view below).
CREATE TABLE IF NOT EXISTS charges (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  procedure_id          INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  payer_id              INTEGER NOT NULL REFERENCES payers(id),
  negotiated_dollar     DOUBLE PRECISION,    -- standard_charge|negotiated_dollar
  negotiated_percentage DOUBLE PRECISION,    -- standard_charge|negotiated_percentage
  negotiated_algorithm  TEXT,                -- standard_charge|negotiated_algorithm
  methodology           TEXT,                -- case rate | fee schedule | per diem | %...
  -- CMS distributional estimate fields (kept losslessly; not the negotiated rate):
  median_amount         DOUBLE PRECISION,
  pct_10                DOUBLE PRECISION,    -- 10th_percentile
  pct_90                DOUBLE PRECISION,    -- 90th_percentile
  rate_count            TEXT,                -- count  (often a range, e.g. "1 through 10")
  payer_notes           TEXT                 -- additional_payer_notes
);

CREATE INDEX IF NOT EXISTS idx_proc_hospital     ON procedures (hospital_id);
CREATE INDEX IF NOT EXISTS idx_proc_description   ON procedures USING gin (to_tsvector('english', coalesce(description,'')));
CREATE INDEX IF NOT EXISTS idx_code_code          ON procedure_codes (code);
CREATE INDEX IF NOT EXISTS idx_code_procedure     ON procedure_codes (procedure_id);
CREATE INDEX IF NOT EXISTS idx_charge_procedure   ON charges (procedure_id);
CREATE INDEX IF NOT EXISTS idx_charge_payer       ON charges (payer_id);

-- DERIVED, not stored: a comparable dollar amount per charge for "lowest cost"
-- queries. Uses the raw negotiated_dollar when present, else estimates from the
-- percentage applied to the procedure's gross charge. Algorithm-only rates have
-- no derivable dollar (NULL). Rebuildable any time — no data is committed to it.
CREATE OR REPLACE VIEW cheapest_charges AS
SELECT
  c.id              AS charge_id,
  c.procedure_id,
  c.payer_id,
  p.hospital_id,
  COALESCE(
    c.negotiated_dollar,
    c.negotiated_percentage / 100.0 * p.gross_charge
  )                 AS estimated_dollar,
  c.negotiated_dollar IS NOT NULL AS is_exact_dollar,
  c.methodology
FROM charges c
JOIN procedures p ON p.id = c.procedure_id;
`;
