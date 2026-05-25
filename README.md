# Medicost

Hospitals are legally required to publish machine-readable files (MRFs) of their prices.
Medicost fetches those files, parses them into Postgres, and serves the prices as
**searchable** — by billing code, with each payer's negotiated rate, cheapest first.

> One **charge** = one procedure's negotiated rate for one payer/plan. A procedure has
> many charges; a hospital has many procedures.

This is a [Bun](https://bun.com) workspace monorepo with four packages, scoped (for now)
to **New York City** hospitals.

**Guiding principle:** keep what a *patient would search for*. We store the source
losslessly on disk, but the database holds only patient-shoppable procedures
(standardized CPT / HCPCS / DRG codes) — not the chargemaster noise (internal CDM codes,
revenue codes, drugs, supplies). Derived numbers (e.g. "lowest cost") are computed at
query time, not stored.

> **Status (POC):** 25 NYC hospitals ingested, ~50M charges, ~10GB local Postgres.
> Known next steps: (1) **collapse/condense** the data to a smaller served slice before
> pushing to Railway (the raw grain is too big — same procedure repeats across internal
> billing dimensions a patient doesn't care about); (2) a **payer-bucketing** table to
> group insurer name variants (e.g. all the "Aetna …" plans) without flattening real
> plan-level rate differences. Built to accommodate the remaining ~35 NYC hospitals.

---

## The packages

```
packages/
├── db/        @medicost/db       schema + connection + shared types  (the core)
├── api/       @medicost/api      Hono HTTP API over Postgres
├── sources/   @medicost/sources  one file per hospital → ingest into Postgres
└── client/    @medicost/client   React + Vite frontend (talks to api over HTTP)
```

**Dependency direction:** `api` and `sources` both depend on `db`. `client` depends on
nothing internal — it only calls `api` over HTTP and never touches the database. Nothing
depends on `api` or `sources`. Keep it that way.

### `@medicost/db` — the shared core

The one place that knows the database exists. Holds:

- the Postgres **schema** — 5 tables + 1 view:
  - `hospitals`, `payers`
  - `procedures` — one distinct item + its payer-less charges (gross, discounted cash, min/max)
  - `procedure_codes` — a procedure's 1..N billing codes (search-by-any-code; no "primary")
  - `charges` — one payer/plan's rate, stored **raw**: dollar / percentage / algorithm kept
    as separate columns, never collapsed
  - `cheapest_charges` (view) — **derived** `estimated_dollar` = `COALESCE(dollar, pct/100 × gross)`,
    for "lowest cost" sorting. Rebuildable; nothing committed to it.
- the shared **`Bun.sql` connection** (reads `DATABASE_URL`),
- the shared **row types** (`Procedure`, `ProcedureCode`, `Charge`, `CheapestCharge`).

Apply the schema with `bun run db:migrate`.

### `@medicost/api` — the HTTP API

A [Hono](https://hono.dev) server on Bun, querying Postgres with async `Bun.sql`.

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{ ok, hospitals, charges }` — row counts |
| `GET /api/search?code=70551` | all hospitals' rates for that billing code, **cheapest first** |

Minimal prototype search: one billing code in → ranked-by-price list out, across all
loaded NYC hospitals. No payer/insurer filtering or description search yet (deliberate).
Port **auto-increments** from `PORT` (default 3000) if taken, so instances don't collide.

### `@medicost/sources` — fetch + ingest (two stages, registry-driven)

Hospitals republish their MRFs constantly and the file URL changes, so we don't hardcode
URLs. Instead a **registry** (`registry/nyc-registry.json`, seeded from the NYS DOH
facility dataset) maps each hospital to its durable `cms-hpt.txt` URL.

- **Stage 1 — fetch** (`src/fetch.ts`): `bun run fetch <slug>` reads the hospital's
  `cms-hpt.txt`, follows the *current* `mrf-url`, downloads to `data/raw/` (gitignored),
  and records a trace. Re-reading the txt each run = always the latest file.
- **Stage 2 — ingest** (`src/ingest.ts`): `bun run ingest <slug>` finds the raw file,
  auto-unzips, **auto-detects the format** (wide CSV / tall CSV / JSON), parses via
  `src/parsers/*`, and loads Postgres. Records `ingested_at` + counts back into the registry.

Ingestion is **per-hospital and idempotent** (re-ingest deletes that hospital's procedures
→ cascades to codes + charges → reloads) and applies the **shoppable filter** (`isShoppable`
in `lib.ts`): keeps only CPT/HCPCS/DRG-coded procedures, dropping chargemaster/drug/supply
noise (CDM, RC, NDC, J/A/B-prefixed HCPCS, junk descriptions).

Run `bun run fetch` or `bun run ingest` with no slug to list available hospitals.

### `@medicost/client` — the frontend

A React + Vite app (currently the default scaffold). It calls the api over HTTP only.
In production the api's URL is baked in at build time via `VITE_API_URL`.

> **Why Vite here when the rest is pure Bun?** The backend packages follow the project's
> Bun-everything rules. The client is a deliberate exception for React DX — Bun still
> installs and launches it, but Vite is its bundler. See `CLAUDE.md`.

---

## Getting started (local)

### Prerequisites

- [Bun](https://bun.com) (`bun --version`)
- **Postgres** — use the latest major (currently 18). On macOS:
  ```sh
  brew install postgresql@18 && brew services start postgresql@18
  ```

### Setup

```sh
bun install                        # install all workspace deps

createdb medicost                  # create the local dev database
bun run db:migrate                 # apply the schema

# Fetch then ingest a hospital by registry slug (run each with no slug to list them):
bun run fetch nyu-langone-hospitals     # download its current MRF to data/raw/
bun run ingest nyu-langone-hospitals    # parse + load into Postgres
```

`DATABASE_URL` defaults to `postgres://localhost:5432/medicost`. Override it to point at a
different database (e.g. Railway):

```sh
DATABASE_URL=postgres://localhost:5432/medicost bun run db:migrate
```

### Run

```sh
bun run api:dev        # API at http://localhost:3000 (hot reload)
bun run client:dev     # frontend (Vite dev server)
```

Quick check:

```sh
curl "http://localhost:3000/api/health"
curl "http://localhost:3000/api/search?description=transplant"
```

### Root scripts

| Script | Does |
|---|---|
| `bun run db:migrate` | apply the schema to `DATABASE_URL` |
| `bun run ingest <slug>` | parse + load a fetched hospital into Postgres |
| `bun run api:dev` | run the API with hot reload |
| `bun run client:dev` | run the frontend dev server |

(`fetch` lives in the sources package: `cd packages/sources && bun run fetch <slug>`.)

Each is a `bun run --filter <package> …` under the hood; you can also `cd` into a package
and run its scripts directly.

---

## Deployment (Railway)

Heavy work runs **locally**; production just **serves**. You build the dataset on your
machine and sync it up.

**Services:** two app services — `api` and `client` — plus one **managed Postgres**.
No volumes (Postgres replaces the old single-file SQLite database).

> **Don't push the full local DB to Railway.** At 25 hospitals it's ~10GB of mostly
> patient-irrelevant grain (same procedure repeated across internal billing dimensions).
> A full `pg_dump` of that is slow, costly on Railway storage/compute, and wasteful. The
> intended path is to **condense first** (collapse to one price per hospital × standardized
> code × payer/plan) into a much smaller served slice, then sync only that. Designing that
> condensed slice is the current open work item.

Keep your local and Railway Postgres **major versions matched** so dumps restore cleanly.

---

## Type-checking

```sh
bunx tsc --noEmit --project tsconfig.backend.json   # db + api + sources
cd packages/client && bunx tsc -b                   # client (its own DOM-aware config)
```

The backend packages share the strict root `tsconfig.json`; the client uses its own
because it needs DOM libs and Vite's asset-module types.
