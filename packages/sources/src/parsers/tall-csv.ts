// Parser for the CMS v3.0.0 machine-readable file in "tall" CSV form: one row
// per (procedure × payer/plan), with the procedure's descriptive + payer-less
// columns repeated on every row. Covers Montefiore, BronxCare, NYC H+H (×12).
//
// Layout varies slightly per hospital (extra columns like billing_class,
// count_of_compared_rates, footnote), so we drive everything off COLUMN NAMES,
// never positions. Some files have N metadata rows before the real header; we
// detect the header as the first row containing "description" and "payer_name".
//
// Consecutive rows sharing the same procedure identity (description + codes +
// setting + modifiers) are grouped into one ParsedProcedure with many charges.

import { parse } from "csv-parse";
import { num, str, type ParsedProcedure, type Code, type ChargeRow } from "../lib.ts";

// Pull the 1..N codes from a row's code|1, code|1|type, code|2, ... columns.
function codesFromRow(row: Record<string, string>): Code[] {
  const codes: Code[] = [];
  for (let i = 1; ; i++) {
    if (!(`code|${i}` in row)) break;
    const code = str(row[`code|${i}`]);
    if (code) codes.push({ code, code_type: str(row[`code|${i}|type`]) });
  }
  return codes;
}

// Identity used to group consecutive rows into one procedure.
function procKey(row: Record<string, string>, codes: Code[]): string {
  const codeStr = codes.map((c) => `${c.code}:${c.code_type ?? ""}`).join(",");
  return [
    row["description"] ?? "",
    row["setting"] ?? "",
    row["modifiers"] ?? "",
    codeStr,
  ].join("|");
}

function chargeFromRow(row: Record<string, string>): ChargeRow | null {
  const payer = str(row["payer_name"]);
  if (!payer) return null; // payer-less row (rare) carries only gross/cash/min/max
  return {
    payer_name: payer,
    plan_name: str(row["plan_name"]),
    negotiated_dollar: num(row["standard_charge|negotiated_dollar"]),
    negotiated_percentage: num(row["standard_charge|negotiated_percentage"]),
    negotiated_algorithm: str(row["standard_charge|negotiated_algorithm"]),
    methodology: str(row["standard_charge|methodology"]),
    median_amount: num(row["median_amount"]),
    pct_10: num(row["10th_percentile"]),
    pct_90: num(row["90th_percentile"]),
    rate_count: str(row["count"]),
    payer_notes: str(row["additional_payer_notes"]),
  };
}

function procFromRow(
  row: Record<string, string>,
  codes: Code[],
): ParsedProcedure {
  return {
    description: str(row["description"]),
    setting: str(row["setting"]),
    modifiers: str(row["modifiers"]),
    drug_unit: str(row["drug_unit_of_measurement"]),
    drug_type: str(row["drug_type_of_measurement"]),
    gross_charge: num(row["standard_charge|gross"]),
    discounted_cash_price: num(row["standard_charge|discounted_cash"]),
    min_negotiated_rate: num(row["standard_charge|min"]),
    max_negotiated_rate: num(row["standard_charge|max"]),
    generic_notes: str(row["additional_generic_notes"]),
    codes,
    charges: [],
  };
}

export async function* parseTallCsv(
  path: string,
): AsyncGenerator<ParsedProcedure> {
  // relaxColumnCount: metadata rows have a different width than the data rows.
  const parser = parse({ relaxColumnCount: true, skipEmptyLines: true });
  const stream = Bun.file(path).stream();
  const pump = (async () => {
    for await (const chunk of stream) parser.write(chunk);
    parser.end();
  })();

  let header: string[] | null = null;
  let current: ParsedProcedure | null = null;
  let currentKey = "";

  for await (const rec of parser as AsyncIterable<string[]>) {
    // The header is the first row that has both description and payer_name.
    if (!header) {
      const trimmed = rec.map((c) => c.trim());
      if (trimmed.includes("description") && trimmed.includes("payer_name")) {
        header = trimmed;
      }
      continue;
    }

    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = rec[i] ?? "";

    const codes = codesFromRow(row);
    const key = procKey(row, codes);
    if (key !== currentKey) {
      if (current) yield current;
      current = procFromRow(row, codes);
      currentKey = key;
    }
    const charge = chargeFromRow(row);
    if (charge) current!.charges.push(charge);
  }

  if (current) yield current;
  await pump;
}
