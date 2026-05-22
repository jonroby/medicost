# Medicost

Hospitals are legally required to publish machine-readable files of their prices.
Medicost parses those files into Postgres so the prices are actually **searchable** —
by procedure description or billing code, with each payer's negotiated rate.

> One **charge** = one procedure at one price for one payer. A hospital has many charges.

This is a [Bun](https://bun.com) workspace monorepo with four packages, heading toward a
free web app with code + ZIP search across many NYC hospitals.

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

- the Postgres **schema** (`hospitals`, `payers`, `charges`),
- the shared **`Bun.sql` connection** (reads `DATABASE_URL`),
- the shared **row types** (`Proc`, `Rate`).

Apply the schema with `bun run db:migrate`. Both `api` and `sources` import `sql` and the
types from here, so the schema is described in exactly one place.

### `@medicost/api` — the HTTP API

A [Hono](https://hono.dev) server on Bun, querying Postgres with async `Bun.sql`.

| Endpoint | Returns |
|---|---|
| `GET /api/health` | `{ ok, hospitals, charges }` — row counts |
| `GET /api/search?billing_code=70551` | exact billing-code match |
| `GET /api/search?description=MRI%20brain` | description substring (case-insensitive) |
| `GET /api/search?billing_code=…&description=…` | both filters, ANDed |

Each result includes the cash price, gross charge, and every payer's negotiated rate
sorted low→high. The server's port **auto-increments** from `PORT` (default 3000) if the
port is taken, so multiple instances (e.g. across git worktrees) don't collide.

### `@medicost/sources` — hospital ingestion (the contribution surface)

Each hospital is **one file** in `packages/sources/src/` (e.g. `nyu-langone-tisch.ts`).
A source parses that hospital's published file into `ChargeRow`s and hands them to
`ingestHospital()` in `lib.ts`, which streams them into Postgres in batched transactions.

Ingestion is **per-hospital and idempotent**: running a source replaces only that
hospital's charges (delete + re-insert in a transaction), leaving every other hospital
untouched. Re-running is always safe.

**To add a hospital:** copy `nyu-langone-tisch.ts`, adapt the parsing to that hospital's
file format, and call `ingestHospital()` with its `ChargeRow`s. That's the whole contract.

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

# Ingest a hospital. Put its file in packages/sources/data/raw/ first (gitignored).
bun run ingest packages/sources/data/raw/nyu-langone-tisch.csv
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
| `bun run ingest <file>` | ingest a hospital file into Postgres |
| `bun run api:dev` | run the API with hot reload |
| `bun run client:dev` | run the frontend dev server |

Each is a `bun run --filter <package> …` under the hood; you can also `cd` into a package
and run its scripts directly.

---

## Deployment (Railway)

Heavy work runs **locally**; production just **serves**. You build the dataset on your
machine and sync it up.

**Services:** two app services — `api` and `client` — plus one **managed Postgres**.
No volumes (Postgres replaces the old single-file SQLite database).

**Sync (for now):** full dump and restore.

```sh
pg_dump "$LOCAL_DATABASE_URL" | psql "$RAILWAY_DATABASE_URL"
```

Keep your local and Railway Postgres **major versions matched** so dumps restore cleanly.

**Later (multiple hospitals):** instead of re-dumping everything, point a source straight
at Railway's `DATABASE_URL` and ingest just the new hospital. Because the data is
partitioned by `hospital_id` and ingestion is idempotent, this only moves one hospital's
rows and never rewrites the rest.

---

## Type-checking

```sh
bunx tsc --noEmit --project tsconfig.backend.json   # db + api + sources
cd packages/client && bunx tsc -b                   # client (its own DOM-aware config)
```

The backend packages share the strict root `tsconfig.json`; the client uses its own
because it needs DOM libs and Vite's asset-module types.
