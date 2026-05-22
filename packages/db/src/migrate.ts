// Create the Medicost schema in the database named by DATABASE_URL.
// Safe to re-run; every statement uses IF NOT EXISTS.
//
//   DATABASE_URL=postgres://localhost/medicost bun run migrate

import { sql, SCHEMA } from "./index.ts";

await sql.unsafe(SCHEMA);
console.log("Schema applied: hospitals, payers, charges");
await sql.end();
