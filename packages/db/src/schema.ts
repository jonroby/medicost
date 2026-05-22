// The Medicost Postgres schema. One charge = one procedure at one price for
// one payer; a hospital has many charges. Safe to re-run (IF NOT EXISTS).

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS hospitals (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  city          TEXT,
  state         TEXT DEFAULT 'NY',
  zip           TEXT,
  source_url    TEXT,
  last_ingested TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payers (
  id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT NOT NULL,
  plan_name TEXT,
  UNIQUE (name, plan_name)
);

CREATE TABLE IF NOT EXISTS charges (
  id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hospital_id         INTEGER NOT NULL REFERENCES hospitals(id),
  payer_id            INTEGER REFERENCES payers(id),
  billing_code        TEXT,
  billing_code_type   TEXT,
  description         TEXT,
  setting             TEXT,
  gross_charge        DOUBLE PRECISION,
  discounted_cash_price DOUBLE PRECISION,
  negotiated_rate     DOUBLE PRECISION,
  min_negotiated_rate DOUBLE PRECISION,
  max_negotiated_rate DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_charges_code     ON charges (billing_code);
CREATE INDEX IF NOT EXISTS idx_charges_hospital ON charges (hospital_id);
CREATE INDEX IF NOT EXISTS idx_charges_payer    ON charges (payer_id);
`;
