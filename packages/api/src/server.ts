// Medicost search API — Bun + Hono + Postgres (Bun.sql).
//
//   bun --hot src/server.ts        -> http://localhost:3000
//
// Endpoints:
//   GET /api/health                                       -> { ok, hospitals, charges }
//   GET /api/search   ?billing_code=70551                 -> exact code match
//                     ?description=MRI%20brain            -> description substring
//                     ?billing_code=70551&description=MRI -> both, ANDed together

import { Hono } from "hono";
import { sql, type Proc, type Rate } from "@medicost/db";

// Filters callers may pass as query params. Each present, non-empty one adds a
// WHERE clause; multiple are ANDed together.
type Filters = {
  billing_code?: string; // exact match
  description?: string; // substring (LIKE)
};

async function findProcedures(filters: Filters): Promise<Proc[]> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.billing_code) {
    params.push(filters.billing_code);
    clauses.push(`c.billing_code = $${params.length}`);
  }
  if (filters.description) {
    params.push(`%${filters.description}%`);
    clauses.push(`c.description ILIKE $${params.length}`);
  }
  if (clauses.length === 0) return [];

  return sql.unsafe(
    `SELECT DISTINCT h.name AS hospital, c.description, c.billing_code,
            c.billing_code_type, c.setting
       FROM charges c JOIN hospitals h ON h.id = c.hospital_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.description, c.setting LIMIT 50`,
    params,
  ) as Promise<Proc[]>;
}

// For a given procedure, the no-payer "cash" row carrying gross + cash price.
function cashFor(p: Proc) {
  return sql`
    SELECT discounted_cash_price, gross_charge FROM charges
     WHERE hospital_id = (SELECT id FROM hospitals WHERE name = ${p.hospital})
       AND description = ${p.description}
       AND COALESCE(setting, '') = COALESCE(${p.setting}, '')
       AND COALESCE(billing_code, '') = COALESCE(${p.billing_code}, '')
       AND payer_id IS NULL
     LIMIT 1`;
}

// Every payer/plan's negotiated rate for a procedure, low to high.
function ratesFor(p: Proc) {
  return sql`
    SELECT pa.name, pa.plan_name, c.negotiated_rate
      FROM charges c JOIN payers pa ON pa.id = c.payer_id
     WHERE c.hospital_id = (SELECT id FROM hospitals WHERE name = ${p.hospital})
       AND c.description = ${p.description}
       AND COALESCE(c.setting, '') = COALESCE(${p.setting}, '')
       AND COALESCE(c.billing_code, '') = COALESCE(${p.billing_code}, '')
       AND c.negotiated_rate IS NOT NULL
     ORDER BY c.negotiated_rate ASC` as Promise<Rate[]>;
}

async function search(filters: Filters) {
  const procs = await findProcedures(filters);
  return Promise.all(
    procs.map(async (p) => {
      const [cash] = (await cashFor(p)) as Array<{
        discounted_cash_price: number | null;
        gross_charge: number | null;
      }>;
      const rates = await ratesFor(p);
      return {
        hospital: p.hospital,
        description: p.description,
        billingCode: p.billing_code,
        billingCodeType: p.billing_code_type,
        setting: p.setting,
        cashPrice: cash?.discounted_cash_price ?? null,
        grossCharge: cash?.gross_charge ?? null,
        rates,
      };
    }),
  );
}

const app = new Hono();

app.get("/api/health", async (c) => {
  const [stats] = await sql`
    SELECT (SELECT COUNT(*) FROM hospitals) AS hospitals,
           (SELECT COUNT(*) FROM charges)   AS charges`;
  return c.json({ ok: true, ...stats });
});

app.get("/api/search", async (c) => {
  const filters: Filters = {
    billing_code: c.req.query("billing_code")?.trim() || undefined,
    description: c.req.query("description")?.trim() || undefined,
  };
  return c.json({ filters, results: await search(filters) });
});

// Try the preferred port (PORT env or 3000) and climb on collision, so
// servers in parallel worktrees grab 3000, 3001, 3002... without conflict.
const startPort = Number(process.env.PORT) || 3000;
for (let port = startPort; port < startPort + 100; port++) {
  try {
    const server = Bun.serve({ port, fetch: app.fetch });
    console.log(`Listening on ${server.url}`);
    break;
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") continue;
    throw err;
  }
}
