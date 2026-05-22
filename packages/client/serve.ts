// Production static server for the built client (packages/client/dist).
//
// Vite builds to static files; this serves them on Railway's $PORT. Run after
// `bun run build`. For local testing: `PORT=8080 bun run serve`.
//
// Any request that doesn't map to a real file falls back to index.html, so
// client-side routing (when added) works on deep links / refresh.

const DIST = `${import.meta.dir}/dist`;
const port = Number(process.env.PORT) || 8080;

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const filePath = pathname === "/" ? "/index.html" : pathname;

    const file = Bun.file(`${DIST}${filePath}`);
    if (await file.exists()) return new Response(file);

    // SPA fallback: unknown path -> index.html.
    return new Response(Bun.file(`${DIST}/index.html`));
  },
});

console.log(`Serving ${DIST} on http://localhost:${server.port}`);
