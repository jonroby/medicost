// Medicost search API — Bun + Hono.
//
//   bun run src/server.ts        -> http://localhost:3000
//
// Endpoints:
//   GET /api/health                                       -> { ok, hospitals, charges }
//   GET /api/search   ?billing_code=70551                 -> exact code match
//                     ?description=MRI%20brain            -> description substring
//                     ?billing_code=70551&description=MRI -> both, ANDed together

import { Hono } from "hono";
import { Database } from "bun:sqlite";

const DB_PATH = process.env.MEDICOST_DB ?? "medicost.db";
const db = new Database(DB_PATH, { readonly: true });

type Proc = {
  hospital: string;
  description: string;
  billing_code: string | null;
  billing_code_type: string | null;
  setting: string | null;
};
type Rate = { name: string; plan_name: string | null; negotiated_rate: number };

const cashStmt = db.query<{ discounted_cash_price: number | null; gross_charge: number | null }, [string, string, string, string]>(
  `SELECT discounted_cash_price, gross_charge FROM charges
    WHERE hospital_id = (SELECT id FROM hospitals WHERE name = ?)
      AND description = ? AND IFNULL(setting,'') = IFNULL(?,'')
      AND IFNULL(billing_code,'') = IFNULL(?,'')
      AND payer_id IS NULL LIMIT 1`,
);
const ratesStmt = db.query<Rate, [string, string, string, string]>(
  `SELECT p.name, p.plan_name, c.negotiated_rate
     FROM charges c JOIN payers p ON p.id = c.payer_id
    WHERE c.hospital_id = (SELECT id FROM hospitals WHERE name = ?)
      AND c.description = ? AND IFNULL(c.setting,'') = IFNULL(?,'')
      AND IFNULL(c.billing_code,'') = IFNULL(?,'')
      AND c.negotiated_rate IS NOT NULL
    ORDER BY c.negotiated_rate ASC`,
);

// Filters that callers may pass as query params. Each present, non-empty one
// adds a WHERE clause; multiple are ANDed together.
type Filters = {
  billing_code?: string; // exact match
  description?: string; // substring (LIKE)
};

function findProcedures(filters: Filters): Proc[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.billing_code) {
    clauses.push("c.billing_code = ?");
    params.push(filters.billing_code);
  }
  if (filters.description) {
    clauses.push("c.description LIKE ?");
    params.push(`%${filters.description}%`);
  }
  if (clauses.length === 0) return [];

  return db
    .query<Proc, string[]>(
      `SELECT DISTINCT h.name AS hospital, c.description, c.billing_code,
              c.billing_code_type, c.setting
         FROM charges c JOIN hospitals h ON h.id = c.hospital_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY c.description, c.setting LIMIT 50`,
    )
    .all(...params);
}

function search(filters: Filters) {
  const procs = findProcedures(filters);
  return procs.map((p) => {
    const cash = cashStmt.get(p.hospital, p.description, p.setting ?? "", p.billing_code ?? "");
    const rates = ratesStmt.all(p.hospital, p.description, p.setting ?? "", p.billing_code ?? "");
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
  });
}

const app = new Hono();

app.get("/api/health", (c) => {
  const stats = db
    .query<{ hospitals: number; charges: number }, []>(
      "SELECT (SELECT COUNT(*) FROM hospitals) AS hospitals, (SELECT COUNT(*) FROM charges) AS charges",
    )
    .get()!;
  return c.json({ ok: true, ...stats });
});

app.get("/api/search", (c) => {
  const filters: Filters = {
    billing_code: c.req.query("billing_code")?.trim() || undefined,
    description: c.req.query("description")?.trim() || undefined,
  };
  return c.json({ filters, results: search(filters) });
});

export default { port: 3000, fetch: app.fetch };
