// Parser for the CMS v3.0.0 machine-readable file in "wide" CSV form: one row
// per procedure, with each payer/plan as a repeating block of columns. Used by
// NYU Langone. ~424 payer blocks of the form
//   standard_charge|<payer>|<plan>|negotiated_dollar
//   standard_charge|<payer>|<plan>|negotiated_percentage
//   standard_charge|<payer>|<plan>|negotiated_algorithm
//   standard_charge|<payer>|<plan>|methodology
//   median_amount|<payer>|<plan>, 10th_percentile|..., 90th_percentile|...,
//   count|..., additional_payer_notes|...
//
// File shape: row1 = metadata field NAMES, row2 = metadata VALUES, row3 = column
// headers, row4+ = data. Layout (which column index is which field) is resolved
// once from row 3.

import { parse } from "csv-parse";
import { num, str, type ParsedProcedure, type Code, type ChargeRow } from "../lib.ts";

// A payer/plan's set of column indices, keyed by (payer, plan).
type PayerCols = {
  payer: string;
  plan: string;
  dollar?: number;
  percentage?: number;
  algorithm?: number;
  methodology?: number;
  median?: number;
  pct10?: number;
  pct90?: number;
  count?: number;
  notes?: number;
};

type Layout = {
  index: Record<string, number>; // fixed columns by header name
  codePairs: Array<{ code: number; type: number }>;
  payers: PayerCols[];
};

const FIXED = new Set([
  "description",
  "setting",
  "modifiers",
  "drug_unit_of_measurement",
  "drug_type_of_measurement",
  "standard_charge|gross",
  "standard_charge|discounted_cash",
  "standard_charge|min",
  "standard_charge|max",
  "additional_generic_notes",
]);

function buildLayout(header: string[]): Layout {
  const index: Record<string, number> = {};
  const codeIdx: Record<number, { code?: number; type?: number }> = {};
  const payerMap = new Map<string, PayerCols>();

  const payerOf = (payer: string, plan: string): PayerCols => {
    const key = `${payer}||${plan}`;
    let pc = payerMap.get(key);
    if (!pc) {
      pc = { payer: payer.trim(), plan: plan.trim() };
      payerMap.set(key, pc);
    }
    return pc;
  };

  header.forEach((raw, i) => {
    // Some hospitals (e.g. BronxCare) put stray spaces around pipes and numbers:
    // "code | 1 ", "standard_charge | gross". Normalize to the canonical form so
    // matching is exact regardless of that whitespace.
    const col = raw.replace(/\s*\|\s*/g, "|").replace(/\s+/g, " ").trim();
    if (FIXED.has(col)) {
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
    // standard_charge|<payer>|<plan>|<field>
    m = col.match(/^standard_charge\|(.+)\|(.+)\|(negotiated_dollar|negotiated_percentage|negotiated_algorithm|methodology)$/);
    if (m) {
      const pc = payerOf(m[1]!, m[2]!);
      if (m[3] === "negotiated_dollar") pc.dollar = i;
      else if (m[3] === "negotiated_percentage") pc.percentage = i;
      else if (m[3] === "negotiated_algorithm") pc.algorithm = i;
      else if (m[3] === "methodology") pc.methodology = i;
      return;
    }
    // estimate fields: <field>|<payer>|<plan>
    m = col.match(/^(median_amount|10th_percentile|90th_percentile|count|additional_payer_notes)\|(.+)\|(.+)$/);
    if (m) {
      const pc = payerOf(m[2]!, m[3]!);
      if (m[1] === "median_amount") pc.median = i;
      else if (m[1] === "10th_percentile") pc.pct10 = i;
      else if (m[1] === "90th_percentile") pc.pct90 = i;
      else if (m[1] === "count") pc.count = i;
      else if (m[1] === "additional_payer_notes") pc.notes = i;
    }
  });

  const codePairs: Array<{ code: number; type: number }> = [];
  for (const n of Object.keys(codeIdx).map(Number).sort((a, b) => a - b)) {
    const pair = codeIdx[n];
    if (pair?.code !== undefined && pair.type !== undefined) {
      codePairs.push({ code: pair.code, type: pair.type });
    }
  }
  return { index, codePairs, payers: [...payerMap.values()] };
}

export async function* parseWideCsv(
  path: string,
): AsyncGenerator<ParsedProcedure> {
  const parser = parse({ relaxColumnCount: true, skipEmptyLines: true });
  const stream = Bun.file(path).stream();
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
        `  layout: ${layout.codePairs.length} code slots, ` +
          `${layout.payers.length} payer/plan blocks`,
      );
      continue;
    }
    const L = layout!;
    const col = (name: string) => {
      const i = L.index[name];
      return i === undefined ? undefined : rec[i];
    };

    const codes: Code[] = [];
    for (const p of L.codePairs) {
      const c = str(rec[p.code]);
      if (c) codes.push({ code: c, code_type: str(rec[p.type]) });
    }

    const charges: ChargeRow[] = [];
    for (const pc of L.payers) {
      const dollar = pc.dollar !== undefined ? num(rec[pc.dollar]) : null;
      const pct = pc.percentage !== undefined ? num(rec[pc.percentage]) : null;
      const algo = pc.algorithm !== undefined ? str(rec[pc.algorithm]) : null;
      // Skip a payer that has no rate of any kind on this procedure.
      if (dollar === null && pct === null && algo === null) continue;
      charges.push({
        payer_name: pc.payer,
        plan_name: pc.plan || null,
        negotiated_dollar: dollar,
        negotiated_percentage: pct,
        negotiated_algorithm: algo,
        methodology: pc.methodology !== undefined ? str(rec[pc.methodology]) : null,
        median_amount: pc.median !== undefined ? num(rec[pc.median]) : null,
        pct_10: pc.pct10 !== undefined ? num(rec[pc.pct10]) : null,
        pct_90: pc.pct90 !== undefined ? num(rec[pc.pct90]) : null,
        rate_count: pc.count !== undefined ? str(rec[pc.count]) : null,
        payer_notes: pc.notes !== undefined ? str(rec[pc.notes]) : null,
      });
    }

    yield {
      description: str(col("description")),
      setting: str(col("setting")),
      modifiers: str(col("modifiers")),
      drug_unit: str(col("drug_unit_of_measurement")),
      drug_type: str(col("drug_type_of_measurement")),
      gross_charge: num(col("standard_charge|gross")),
      discounted_cash_price: num(col("standard_charge|discounted_cash")),
      min_negotiated_rate: num(col("standard_charge|min")),
      max_negotiated_rate: num(col("standard_charge|max")),
      generic_notes: str(col("additional_generic_notes")),
      codes,
      charges,
    };
  }
  await pump;
}
