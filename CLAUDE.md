---
description: Use Bun instead of Node.js, npm, or pnpm. (The client package uses Vite — see below.)
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# Medicost

Parses hospitals' legally-required price-transparency CSVs into Postgres so prices are
searchable. One charge = one procedure at one price for one payer; a hospital has many
charges.

## Layout — a Bun workspace monorepo (`packages/*`)

- `packages/db` (`@medicost/db`) — the shared core: Postgres schema, the `Bun.sql`
  connection (from `DATABASE_URL`), and shared row types. `bun run db:migrate` applies
  the schema. Both `api` and `sources` import from here; nothing imports *them*.
- `packages/api` (`@medicost/api`) — Hono API on Bun: `GET /api/health` and
  `GET /api/search?billing_code=&description=` (filters ANDed). Async `Bun.sql` queries.
  Port auto-increments from `PORT` (or 3000) so parallel-worktree servers don't collide.
- `packages/sources` (`@medicost/sources`) — one file per hospital (e.g.
  `nyu-langone-tisch.ts`) that parses that hospital's machine-readable file and calls
  `ingestHospital()` in `lib.ts`. Ingest is **per-hospital and idempotent**: re-running a
  source replaces only that hospital's charges, in a transaction. This is the open-source
  contribution surface — add a hospital by adding a file.
- `packages/client` (`@medicost/client`) — React + Vite frontend. Talks to `api` over
  HTTP only (never touches Postgres). Builds to static `dist/`.

Root scripts: `db:migrate`, `ingest`, `api:dev`, `client:dev` (each is a `bun run --filter`).

## Database & deployment

- **Postgres** (local for dev/ingest, Railway managed in prod), accessed via `Bun.sql`.
  Local dev DB: `postgres://localhost:5432/medicost`. Use the **latest** Postgres major
  (currently 18; keep local and Railway versions matched for clean dumps).
- **Heavy work runs locally; prod just serves.** Ingest hospital files into *local*
  Postgres, then sync to Railway. For now sync is a full `pg_dump` → restore:
  ```sh
  pg_dump "$LOCAL_DATABASE_URL" | psql "$RAILWAY_DATABASE_URL"
  ```
  Once there are several hospitals, switch to per-hospital ingest straight against
  Railway's `DATABASE_URL` (the schema is partitioned by `hospital_id`, so this only
  moves one hospital's rows and never rewrites the rest).
- **Railway**: two app services — `api` and `client` — plus one managed Postgres. The
  client bakes the api's URL in at build via `VITE_API_URL`. No volumes (Postgres replaces
  the old SQLite-file-on-disk approach).

Raw hospital dumps live in `packages/sources/data/raw/` (gitignored). Heading toward a free web app with
code + zip search across many NYC hospitals.

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
