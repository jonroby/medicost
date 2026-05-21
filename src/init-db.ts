// Creates the Medicost SQLite database and its tables.
//
// Usage:
//   bun run src/init-db.ts            -> creates ./medicost.db
//   bun run src/init-db.ts foo.db     -> creates ./foo.db
//
// Safe to re-run: every statement uses IF NOT EXISTS.

import { Database } from "bun:sqlite";

const DB_PATH = process.argv[2] ?? "medicost.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hospitals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  state TEXT DEFAULT 'NY',
  zip TEXT,
  source_url TEXT,
  last_ingested TEXT
);

CREATE TABLE IF NOT EXISTS payers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plan_name TEXT,
  UNIQUE(name, plan_name)
);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hospital_id INTEGER NOT NULL REFERENCES hospitals(id),
  payer_id INTEGER REFERENCES payers(id),
  billing_code TEXT,
  billing_code_type TEXT,
  description TEXT,
  setting TEXT,
  gross_charge REAL,
  discounted_cash_price REAL,
  negotiated_rate REAL,
  min_negotiated_rate REAL,
  max_negotiated_rate REAL
);

CREATE INDEX IF NOT EXISTS idx_charges_code ON charges(billing_code);
CREATE INDEX IF NOT EXISTS idx_charges_hospital ON charges(hospital_id);
CREATE INDEX IF NOT EXISTS idx_charges_payer ON charges(payer_id);
`;

const db = new Database(DB_PATH);

// WAL mode keeps reads fast while a large ingest is writing.
db.exec("PRAGMA journal_mode = WAL;");
db.exec(SCHEMA);

console.log(`Initialized database at ${DB_PATH}`);
console.log("Tables: hospitals, payers, charges");

db.close();
