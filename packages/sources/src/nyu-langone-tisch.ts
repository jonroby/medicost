// Ingest NYU Langone Tisch Hospital's standard-charges CSV into Postgres.
//
// Written for ONE specific file: the CMS "wide" V3.0.0 machine-readable file
// published by NYU Langone Tisch (~460MB), streamed row by row. The file lives
// (gitignored) under packages/sources/data/raw/; with no path argument this
// source defaults to that location.
//
//   DATABASE_URL=postgres://localhost/medicost bun run ingest          # default path
//   DATABASE_URL=postgres://localhost/medicost bun run ingest <csv>    # explicit path
//
// File shape (confirmed against the real file):
//   row 1: hospital metadata field NAMES
//   row 2: hospital metadata VALUES
//   row 3: the actual column headers (code|1, description, standard_charge|..., ...)
//   row 4+: data
//
// Fixed leading columns then ~424 repeating 9-column payer/plan blocks of the
// form standard_charge|<payer>|<plan>|negotiated_dollar, then min/max.

import { parse } from "csv-parse";
import { sql } from "@medicost/db";
import { ingestHospital, num, str, type ChargeRow } from "./lib.ts";

const HOSPITAL = {
  name: "NYU Langone Tisch Hospital",
  city: "New York",
  source_url:
    "https://standard-charges-prod.s3.amazonaws.com/pricing_files/133971298-1801992631_nyu-langone-tisch_standardcharges.csv",
};

// Default to the file under packages/sources/data/raw, resolved relative to
// this source file so it works regardless of the invoking directory.
const csvPath =
  process.argv[2] ?? `${import.meta.dir}/../data/raw/nyu-langone-tisch.csv`;

// Column layout, resolved once from the header row (row 3).
type Layout = {
  index: Record<string, number>;
  codePairs: Array<{ code: number; type: number }>;
  payerCols: Array<{ payer: string; plan: string; dollar: number }>;
};

function buildLayout(header: string[]): Layout {
  const index: Record<string, number> = {};
  const codePairs: Array<{ code: number; type: number }> = [];
  const payerCols: Array<{ payer: string; plan: string; dollar: number }> = [];
  const codeIdx: Record<number, { code?: number; type?: number }> = {};

  header.forEach((raw, i) => {
    const col = raw.trim();
    if (
      col === "description" ||
      col === "setting" ||
      col === "standard_charge|gross" ||
      col === "standard_charge|discounted_cash" ||
      col === "standard_charge|min" ||
      col === "standard_charge|max"
    ) {
      index[col] = i;
      return;
    }
    let m = col.match(/^code\|(\d+)$/);
    if (m?.[1]) {
      (codeIdx[+m[1]] ??= {}).code = i;
      return;
    }
    m = col.match(/^code\|(\d+)\|type$/);
    if (m?.[1]) {
      (codeIdx[+m[1]] ??= {}).type = i;
      return;
    }
    m = col.match(/^standard_charge\|(.+)\|(.+)\|negotiated_dollar$/);
    if (m?.[1] && m[2]) {
      payerCols.push({ payer: m[1].trim(), plan: m[2].trim(), dollar: i });
    }
  });

  for (const n of Object.keys(codeIdx).map(Number).sort((a, b) => a - b)) {
    const pair = codeIdx[n];
    if (pair?.code !== undefined && pair.type !== undefined) {
      codePairs.push({ code: pair.code, type: pair.type });
    }
  }
  return { index, codePairs, payerCols };
}

// Parse the CSV and yield ChargeRows: one no-payer "cash" row per procedure
// plus one row per payer/plan that has a negotiated dollar amount.
async function* parseRows(): AsyncGenerator<ChargeRow> {
  const parser = parse({ relaxColumnCount: true, skipEmptyLines: true });

  const stream = Bun.file(csvPath).stream();
  const pump = (async () => {
    for await (const chunk of stream) parser.write(chunk);
    parser.end();
  })();

  let layout: Layout | null = null;
  let rowNum = 0;

  for await (const rec of parser as AsyncIterable<string[]>) {
    rowNum++;
    if (rowNum <= 2) continue; // metadata rows
    if (rowNum === 3) {
      layout = buildLayout(rec);
      console.log(
        `Header parsed: ${layout.codePairs.length} code slots, ${layout.payerCols.length} payer/plan columns`,
      );
      continue;
    }
    const L = layout!;
    // Read a fixed column by its header name (undefined if not present).
    const col = (name: string) => {
      const i = L.index[name];
      return i === undefined ? undefined : rec[i];
    };

    const description = str(col("description"));
    const setting = str(col("setting"));
    const gross = num(col("standard_charge|gross"));
    const cash = num(col("standard_charge|discounted_cash"));
    const minRate = num(col("standard_charge|min"));
    const maxRate = num(col("standard_charge|max"));

    let code: string | null = null;
    let codeType: string | null = null;
    for (const p of L.codePairs) {
      const c = str(rec[p.code]);
      if (c) {
        code = c;
        codeType = str(rec[p.type]);
        break;
      }
    }

    const base = {
      billing_code: code,
      billing_code_type: codeType,
      description,
      setting,
      gross_charge: gross,
      discounted_cash_price: cash,
      min_negotiated_rate: minRate,
      max_negotiated_rate: maxRate,
    };

    // One "cash" row per procedure (no payer).
    yield { ...base, payer: null, negotiated_rate: null };

    // One row per payer/plan with a negotiated dollar amount.
    for (const pc of L.payerCols) {
      const rate = num(rec[pc.dollar]);
      if (rate === null) continue;
      yield { ...base, payer: { name: pc.payer, plan: pc.plan }, negotiated_rate: rate };
    }
  }

  await pump;
}

await ingestHospital(HOSPITAL, parseRows());
await sql.end();
