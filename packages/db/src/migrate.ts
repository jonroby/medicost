// Create the Medicost schema in the database named by DATABASE_URL.
// Safe to re-run; every statement uses IF NOT EXISTS.
//
//   DATABASE_URL=postgres://localhost/medicost bun run migrate

import { sql, SCHEMA } from "./index.ts";

await sql.unsafe(SCHEMA);
console.log(
  "Schema applied: hospitals, payers, procedures, procedure_codes, charges (+ cheapest_charges view)",
);
await sql.end();
