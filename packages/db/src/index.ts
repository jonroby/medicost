// The shared Postgres connection for Medicost, via Bun.sql.
//
// Connection comes from DATABASE_URL (Bun.sql's default). Point it at local
// Postgres when ingesting and at Railway's Postgres when serving:
//   DATABASE_URL=postgres://localhost/medicost
//   DATABASE_URL=<railway-injected-url>

import { SQL } from "bun";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localhost:5432/medicost";

// One pooled client shared across the process. Bun.sql lazily connects.
export const sql = new SQL({ url: DATABASE_URL });

export { SCHEMA } from "./schema.ts";
export type { Proc, Rate } from "./types.ts";
