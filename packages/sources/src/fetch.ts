// Stage 1 of the two-stage pipeline: FETCH one hospital's machine-readable
// price file (MRF) to data/raw/. One hospital per run, selected by slug.
// (Stage 2, parse+load, is a separate step.)
//
//   bun run src/fetch.ts <slug>     # fetch one hospital
//   bun run src/fetch.ts            # list available slugs
//
// Why a registry + per-run resolve: hospitals republish their MRF constantly and
// the file URL changes, but the cms-hpt.txt that points to it is stable. So we
// store only the cms-hpt.txt URL (registry/nyc-registry.json) and re-read it each
// run to follow the CURRENT mrf-url. See memory two-stage-fetch-parse.

type Hospital = {
  fac_id: string;
  slug: string;
  name: string;
  borough: string;
  operator: string;
  cms_hpt_url: string | null;
  location_match: string;
  status: string;
};

const REGISTRY = `${import.meta.dir}/../registry/nyc-registry.json`;
const RAW_DIR = `${import.meta.dir}/../data/raw`;
const TRACE = `${RAW_DIR}/fetch-trace.json`;

// A browser-like UA; some hosts 403 a bare/curl UA. (Akamai-walled hosts may
// still block regardless — those need a download on the user's own machine.)
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function loadRegistry(): Promise<Hospital[]> {
  return JSON.parse(await Bun.file(REGISTRY).text());
}

// Which slugs already have a downloaded file in data/raw/ (any extension).
async function fetchedSlugs(): Promise<Set<string>> {
  const out = new Set<string>();
  const glob = new Bun.Glob("*");
  for await (const f of glob.scan(RAW_DIR)) {
    out.add(f.replace(/\.(json|csv|xlsx|xls)(\.zip)?$/i, "").replace(/\.zip$/i, ""));
  }
  return out;
}

// Parse a cms-hpt.txt into [{ location, mrfUrl }]. Format is repeated blocks of
// `location-name:` / `mrf-url:` lines (plus contact lines we ignore).
function parseHpt(txt: string): Array<{ location: string; mrfUrl: string }> {
  const out: Array<{ location: string; mrfUrl: string }> = [];
  let location = "";
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(location-name|mrf-url)\s*:\s*(.+?)\s*$/i);
    if (!m) continue;
    if (m[1].toLowerCase() === "location-name") location = m[2];
    else out.push({ location, mrfUrl: m[2] });
  }
  return out;
}

// Pick the entry whose location-name best matches the registry location_match.
// Exact (case-insensitive) first, then substring either direction, else the
// first entry (many systems list one shared file under several locations).
function pickMrf(
  entries: Array<{ location: string; mrfUrl: string }>,
  match: string,
): { location: string; mrfUrl: string } | null {
  if (entries.length === 0) return null;
  const m = match.toLowerCase();
  return (
    entries.find((e) => e.location.toLowerCase() === m) ??
    entries.find(
      (e) =>
        e.location.toLowerCase().includes(m) ||
        m.includes(e.location.toLowerCase()),
    ) ??
    entries[0]
  );
}

// Derive a file extension, first from the mrf-url path, then (when the URL has
// no usable extension, e.g. a vendor /MRFDownload/ API path) from the response's
// Content-Type / Content-Disposition headers.
function extFromUrl(url: string): string | null {
  const path = url.split("?")[0]!.toLowerCase();
  const m = path.match(/\.(json\.zip|csv\.zip|json|csv|xlsx|xls|zip)$/);
  return m ? m[1] : null;
}

function extFromHeaders(res: Response): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const fn = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? "";
  const fromName = extFromUrl(fn);
  if (fromName) return fromName;
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("zip")) return "zip";
  if (ct.includes("json")) return "json";
  if (ct.includes("csv")) return "csv";
  if (ct.includes("spreadsheet") || ct.includes("excel")) return "xlsx";
  return "bin";
}

async function appendTrace(rec: object): Promise<void> {
  let arr: object[] = [];
  try {
    arr = JSON.parse(await Bun.file(TRACE).text());
  } catch {
    arr = [];
  }
  arr.push(rec);
  await Bun.write(TRACE, JSON.stringify(arr, null, 2) + "\n");
}

// With no slug arg, print the fetchable slugs (grouped by borough, ✓ if already
// in data/raw/) so the caller knows what to pass.
async function listSlugs(selectable: Hospital[]): Promise<void> {
  const done = await fetchedSlugs();
  console.log(`NYC hospital registry — ${selectable.length} fetchable\n`);
  console.log(`Usage: bun run src/fetch.ts <slug>\n`);
  let lastBorough = "";
  for (const h of selectable) {
    if (h.borough !== lastBorough) {
      console.log(`\n  ${h.borough}`);
      lastBorough = h.borough;
    }
    const mark = done.has(h.slug) ? "✓" : " ";
    console.log(`  ${mark} ${h.slug}`);
  }
}

async function main() {
  const all = await loadRegistry();
  const selectable = all.filter((h) => h.cms_hpt_url); // skip unresolved (Wyckoff)

  const slug = process.argv[2];
  if (!slug) {
    await listSlugs(selectable);
    return;
  }

  const h = selectable.find((x) => x.slug === slug);
  if (!h) {
    console.error(`No fetchable hospital with slug "${slug}".`);
    console.error(`Run with no argument to list valid slugs.`);
    process.exitCode = 1;
    return;
  }
  console.log(`→ ${h.name}\n  cms-hpt: ${h.cms_hpt_url}`);

  const hptRes = await fetch(h.cms_hpt_url!, { headers: { "User-Agent": UA } });
  if (!hptRes.ok) {
    console.error(
      `  cms-hpt.txt fetch failed: HTTP ${hptRes.status}. ` +
        `If Akamai-blocked, download on your own machine.`,
    );
    return;
  }
  const entries = parseHpt(await hptRes.text());
  const chosen = pickMrf(entries, h.location_match);
  if (!chosen) {
    console.error(`  No mrf-url found in cms-hpt.txt.`);
    return;
  }
  console.log(`  matched location: "${chosen.location}"`);
  console.log(`  mrf-url: ${chosen.mrfUrl}`);
  console.log(`  downloading ...`);

  const fileRes = await fetch(chosen.mrfUrl, { headers: { "User-Agent": UA } });
  if (!fileRes.ok) {
    console.error(
      `  download failed: HTTP ${fileRes.status}. ` +
        `If Akamai-blocked, run the download on your own machine.`,
    );
    return;
  }
  const ext = extFromUrl(chosen.mrfUrl) ?? extFromHeaders(fileRes);
  const dest = `${RAW_DIR}/${h.slug}.${ext}`;
  await Bun.write(dest, fileRes);
  const size = (await Bun.file(dest).stat()).size;
  console.log(`  → ${dest}`);

  await appendTrace({
    fac_id: h.fac_id,
    slug: h.slug,
    name: h.name,
    cms_hpt_url: h.cms_hpt_url,
    matched_location: chosen.location,
    mrf_url: chosen.mrfUrl,
    dest,
    bytes: size,
    fetched_at: new Date().toISOString(),
  });

  console.log(`  done: ${(size / 1e6).toFixed(1)} MB. Trace updated.`);
}

await main();
