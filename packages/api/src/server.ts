// Medicost search API — Bun + Hono + Postgres (Bun.sql).
//
//   bun --hot src/server.ts        -> http://localhost:3000
//
// Minimal early-prototype search: user gives a billing code; we return every
// hospital's rates for that code across NYC, cheapest first. No payer matching,
// no description search yet — those come later (e.g. only showing rates for the
// user's own insurer). Price uses the derived cheapest_charges view
// (negotiated dollar, or percentage × gross when that's all the hospital gave).
//
// Endpoints:
//   GET /api/health              -> { ok, hospitals, charges }
//   GET /api/search?code=70551   -> rates for that billing code, cheapest first

import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "@medicost/db";

// One returned rate: a hospital's price for the searched code, via a payer/plan.
type SearchRow = {
  hospital: string;
  borough: string | null;
  code: string;
  code_type: string | null;
  description: string | null;
  setting: string | null;
  payer: string;
  plan_name: string | null;
  estimated_dollar: number | null;
  is_exact_dollar: boolean;
  methodology: string | null;
};

// All rates for a billing code, cheapest first. Joins procedure_codes → the
// procedure → its hospital and per-payer charges (priced via cheapest_charges).
// Rows with no derivable dollar (algorithm-only) sort last.
function searchByCode(code: string): Promise<SearchRow[]> {
  return sql`
    SELECT h.name              AS hospital,
           h.borough,
           pc.code,
           pc.code_type,
           p.description,
           p.setting,
           pay.name            AS payer,
           pay.plan_name,
           cc.estimated_dollar,
           cc.is_exact_dollar,
           cc.methodology
      FROM procedure_codes pc
      JOIN procedures p        ON p.id = pc.procedure_id
      JOIN hospitals h         ON h.id = p.hospital_id
      JOIN cheapest_charges cc ON cc.procedure_id = p.id
      JOIN payers pay          ON pay.id = cc.payer_id
     WHERE pc.code = ${code}
     ORDER BY cc.estimated_dollar ASC NULLS LAST
     LIMIT 500` as Promise<SearchRow[]>;
}

const app = new Hono();

// The client is served from a different origin (Vite dev server, or the built
// static site in prod), so it needs CORS to call this API from the browser.
// Allow any localhost dev port plus an optional configured prod origin.
const allowedOrigin = process.env.CLIENT_ORIGIN;
app.use(
  "/api/*",
  cors({
    origin: (origin) =>
      !origin || /^http:\/\/localhost:\d+$/.test(origin) || origin === allowedOrigin
        ? origin || "*"
        : null,
  }),
);

app.get("/api/health", async (c) => {
  const [stats] = await sql`
    SELECT (SELECT COUNT(*) FROM hospitals) AS hospitals,
           (SELECT COUNT(*) FROM charges)   AS charges`;
  return c.json({ ok: true, ...stats });
});

app.get("/api/search", async (c) => {
  const code = c.req.query("code")?.trim();
  if (!code) {
    return c.json({ error: "pass a billing ?code=, e.g. /api/search?code=70551" }, 400);
  }
  const results = await searchByCode(code);
  return c.json({ code, count: results.length, results });
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
