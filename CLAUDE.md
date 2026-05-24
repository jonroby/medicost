---
description: Use Bun instead of Node.js, npm, or pnpm. (The client package uses Vite — see below.)
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Medicost

Fetches hospitals' legally-required price-transparency files (MRFs), parses them into
Postgres, and serves them as searchable prices. One **charge** = one procedure's
negotiated rate for one payer/plan; a procedure has many charges, a hospital has many
procedures. Scope (for now): **NYC** hospitals.

**Guiding principle — keep what a patient would search for.** Store the source losslessly
on disk, but the DB holds only **patient-shoppable** procedures (standardized CPT / HCPCS /
DRG codes), not chargemaster noise (internal CDM/RC codes, drugs, supplies). Derived
numbers ("lowest cost", percentage→dollar) are computed at **query time**, not stored.

## Layout — a Bun workspace monorepo (`packages/*`)

- `packages/db` (`@medicost/db`) — the shared core: Postgres schema, the `Bun.sql`
  connection (from `DATABASE_URL`), shared types. `bun run db:migrate` applies the schema.
  **5 tables + 1 view:** `hospitals`, `payers`, `procedures` (distinct item + its
  payer-less gross/cash/min/max), `procedure_codes` (1..N codes per procedure),
  `charges` (one payer/plan rate — dollar/percentage/algorithm kept as separate raw
  columns, never collapsed), and the `cheapest_charges` **view** (derived
  `estimated_dollar = COALESCE(dollar, pct/100*gross)`). Both `api` and `sources` import
  from here; nothing imports *them*.
- `packages/api` (`@medicost/api`) — Hono API on Bun. `GET /api/health`,
  `GET /api/search?code=<billing_code>` → all hospitals' rates for that code, cheapest
  first (via the view). Minimal by design: no payer/description filtering yet. Port
  auto-increments from `PORT` (or 3000) so parallel-worktree servers don't collide.
- `packages/sources` (`@medicost/sources`) — **two-stage, registry-driven**:
  - `registry/nyc-registry.json` (built from NYS DOH dataset by `build-registry.ts`) maps
    each hospital → its durable `cms-hpt.txt` URL + `location_match`. Re-running ingest
    stamps `ingested_at` + counts back into it.
  - **Stage 1 fetch** (`src/fetch.ts`, `bun run fetch <slug>`): reads cms-hpt.txt, follows
    the current `mrf-url`, downloads to `data/raw/` (gitignored).
  - **Stage 2 ingest** (`src/ingest.ts`, `bun run ingest <slug>`): unzips, auto-detects
    format (wide CSV / tall CSV / JSON → `src/parsers/*`), applies the **shoppable filter**
    (`isShoppable` in `lib.ts`), loads Postgres. **Per-hospital & idempotent** (re-ingest
    deletes that hospital's procedures, cascading to codes+charges, then reloads).
- `packages/client` (`@medicost/client`) — React + Vite frontend. Talks to `api` over
  HTTP only (never touches Postgres). Builds to static `dist/`.

Root scripts: `db:migrate`, `ingest`, `api:dev`, `client:dev`. (`fetch` is in the sources
package.) Run `ingest`/`fetch` with no slug to list hospitals.

## Database & deployment

- **Postgres** (local for dev/ingest, Railway managed in prod), via `Bun.sql`. Local dev
  DB: `postgres://localhost:5432/medicost`. Use the **latest** Postgres major (currently 18;
  keep local and Railway matched for clean dumps).
- **Heavy work runs locally; prod just serves.**
- **DON'T push the full local DB to Railway.** At 25 hospitals it's ~10GB of mostly
  patient-irrelevant grain (same procedure repeated across internal billing dimensions).
  The intended path: **condense first** (one price per hospital × standardized code ×
  payer/plan) into a small served slice, then sync only that. *Designing that condensed
  slice is open work.*
- **Railway**: two app services (`api`, `client`) + one managed Postgres. Client bakes the
  api URL in at build via `VITE_API_URL`. No volumes.

Raw MRFs live in `packages/sources/data/raw/` (gitignored, large). Persistent project notes
& decisions are in the agent memory dir (see MEMORY.md there).

> **Vite exception:** the rules below say "don't use Vite" — that was written when this
> was a Bun-only backend. It still holds for `db`/`api`/`sources`. The **`client`**
> package deliberately uses React + Vite for frontend DX; Bun still installs and runs it
> (`bun install`, `bun run --filter @medicost/client dev`), but Vite is its bundler.

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
