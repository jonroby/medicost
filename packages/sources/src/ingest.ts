// Stage 2 of the pipeline: PARSE a hospital's raw file (from data/raw/) and LOAD
// it into Postgres. One hospital per run, selected by registry slug.
//
//   DATABASE_URL=postgres://localhost/medicost bun run src/ingest.ts <slug>
//   bun run src/ingest.ts                 # list slugs that have a raw file
//
// Picks the parser by file format. CMS encodes the same v3.0.0 data three ways:
//   wide CSV  (one row/procedure, payers as repeating columns) — NYU only
//   tall CSV  (one row per procedure×payer)                    — Montefiore, BronxCare, H+H
//   JSON      (nested procedure→charges→payers array)          — Mount Sinai, MSK, NYP, Lenox Hill
// .zip files are unzipped (cached) then re-detected. See memory two-stage-fetch-parse.

import { sql } from "@medicost/db";
import { ingestHospital, type Hospital } from "./lib.ts";
import { parseCmsJson } from "./parsers/cms-json.ts";
import { parseTallCsv } from "./parsers/tall-csv.ts";
import { parseWideCsv } from "./parsers/wide-csv.ts";

type RegistryEntry = {
  fac_id: string;
  slug: string;
  name: string;
  borough: string;
  cms_hpt_url: string | null;
  location_match: string;
};

const RAW_DIR = `${import.meta.dir}/../data/raw`;
const REGISTRY = `${import.meta.dir}/../registry/nyc-registry.json`;

async function loadRegistry(): Promise<RegistryEntry[]> {
  return JSON.parse(await Bun.file(REGISTRY).text());
}

// Find the raw file for a slug (any extension) in data/raw/.
async function rawFileFor(slug: string): Promise<string | null> {
  const glob = new Bun.Glob(`${slug}.*`);
  for await (const f of glob.scan(RAW_DIR)) return `${RAW_DIR}/${f}`;
  return null;
}

// If the file is a .zip, extract its single member next to it (cached) and
// return that path; otherwise return the path unchanged.
async function unzipIfNeeded(path: string): Promise<string> {
  if (!path.endsWith(".zip")) return path;
  // e.g. foo.json.zip -> foo.json ; foo.zip -> foo.csv (member name from listing)
  const listing = await new Response(
    Bun.spawn(["unzip", "-Z1", path]).stdout,
  ).text();
  const member = listing.split("\n").map((s) => s.trim()).find(Boolean);
  if (!member) throw new Error(`empty zip: ${path}`);
  const out = `${RAW_DIR}/${member}`;
  if (!(await Bun.file(out).exists())) {
    console.log(`  unzipping ${member} ...`);
    const proc = Bun.spawn(["unzip", "-o", "-j", path, member, "-d", RAW_DIR]);
    if ((await proc.exited) !== 0) throw new Error(`unzip failed: ${path}`);
  }
  return out;
}

// A CSV is "wide" (payers as repeating columns) if its header carries
// per-payer standard_charge columns; "tall" (one row per payer) if it has a
// bare payer_name column. Detect from the header rather than hardcoding slugs,
// since hospitals using the same vendor share a layout (e.g. NYU + BronxCare = wide).
async function csvIsWide(path: string): Promise<boolean> {
  const head = await Bun.file(path).slice(0, 200_000).text();
  // Strip whitespace around pipes so "standard_charge | X | Y |negotiated" matches.
  const norm = head.replace(/\s*\|\s*/g, "|");
  const firstLines = norm.split("\n").slice(0, 6).join("\n");
  if (/(^|,)payer_name(,|$)/m.test(firstLines)) return false; // tall
  return /standard_charge\|[^,|]+\|[^,|]+\|negotiated_/.test(norm); // wide
}

async function parserFor(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".json")) return parseCmsJson(path);
  if (p.endsWith(".csv")) {
    return (await csvIsWide(path)) ? parseWideCsv(path) : parseTallCsv(path);
  }
  throw new Error(`don't know how to parse ${path}`);
}

async function listAvailable(reg: RegistryEntry[]): Promise<void> {
  console.log(`Hospitals with a raw file in data/raw/:\n`);
  for (const h of reg) {
    const f = await rawFileFor(h.slug);
    if (f) console.log(`  ${h.slug}  (${f.split("/").pop()})`);
  }
}

async function main() {
  const reg = await loadRegistry();
  const slug = process.argv[2];
  if (!slug) {
    await listAvailable(reg);
    return;
  }

  const entry = reg.find((h) => h.slug === slug);
  if (!entry) {
    console.error(`No registry hospital with slug "${slug}".`);
    process.exitCode = 1;
    return;
  }
  const raw = await rawFileFor(slug);
  if (!raw) {
    console.error(`No raw file for "${slug}" in data/raw/. Fetch it first.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Ingesting ${entry.name}\n  raw: ${raw.split("/").pop()}`);
  const path = await unzipIfNeeded(raw);

  const hospital: Hospital = {
    fac_id: entry.fac_id,
    name: entry.name,
    borough: entry.borough,
    source_url: entry.cms_hpt_url ?? undefined,
  };

  await ingestHospital(hospital, await parserFor(path));
  await sql.end();
}

await main();
