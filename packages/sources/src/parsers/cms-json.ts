// Parser for the CMS v3.0.0 machine-readable file in JSON form. Covers Mount
// Sinai (×6), MSK, NYP (×2), Lenox Hill — the most common format in our set.
//
// Shape (confirmed across those files):
//   { hospital_name, last_updated_on, version, location_name, ...,
//     standard_charge_information: [
//       { description, code_information: [{code, type}, ...],
//         drug_information?: { unit, type },
//         standard_charges: [
//           { setting, gross_charge?, discounted_cash?, minimum?, maximum?,
//             additional_generic_notes?,
//             payers_information: [
//               { payer_name, plan_name, standard_charge_dollar?,
//                 standard_charge_percentage?, standard_charge_algorithm?,
//                 methodology?, median_amount?, "10th_percentile"?,
//                 "90th_percentile"?, count?, additional_payer_notes? }, ... ] } ] } ] }
//
// One ParsedProcedure is emitted per (procedure × standard_charges entry), since
// the payer-less charges (gross/cash/min/max) live at the standard_charges level
// and can differ by setting.

import { num, str, type ParsedProcedure, type Code } from "../lib.ts";

type RawPayer = {
  payer_name?: string;
  plan_name?: string;
  standard_charge_dollar?: number | string;
  standard_charge_percentage?: number | string;
  standard_charge_algorithm?: string;
  methodology?: string;
  median_amount?: number | string;
  "10th_percentile"?: number | string;
  "90th_percentile"?: number | string;
  count?: number | string;
  additional_payer_notes?: string;
};

type RawCharge = {
  setting?: string;
  gross_charge?: number | string;
  discounted_cash?: number | string;
  minimum?: number | string;
  maximum?: number | string;
  additional_generic_notes?: string;
  payers_information?: RawPayer[];
};

type RawProc = {
  description?: string;
  code_information?: Array<{ code?: string | number; type?: string }>;
  drug_information?: { unit?: string; type?: string };
  standard_charges?: RawCharge[];
};

type RawFile = { standard_charge_information?: RawProc[] };

// Whole-file JSON.parse. These files are large (up to ~700MB) but fit in memory
// under Bun. If a file ever exceeds memory, swap in a streaming JSON parser here.
export async function* parseCmsJson(
  path: string,
): AsyncGenerator<ParsedProcedure> {
  const file: RawFile = JSON.parse(await Bun.file(path).text());
  const procs = file.standard_charge_information ?? [];

  for (const p of procs) {
    const codes: Code[] = (p.code_information ?? [])
      .map((ci) => ({ code: str(ci.code as string), code_type: str(ci.type) }))
      .filter((c): c is Code => c.code !== null);

    const description = str(p.description);
    const drugUnit = str(p.drug_information?.unit);
    const drugType = str(p.drug_information?.type);

    for (const ch of p.standard_charges ?? []) {
      const charges = (ch.payers_information ?? [])
        .filter((pi) => str(pi.payer_name))
        .map((pi) => ({
          payer_name: str(pi.payer_name)!,
          plan_name: str(pi.plan_name),
          negotiated_dollar: num(pi.standard_charge_dollar),
          negotiated_percentage: num(pi.standard_charge_percentage),
          negotiated_algorithm: str(pi.standard_charge_algorithm),
          methodology: str(pi.methodology),
          median_amount: num(pi.median_amount),
          pct_10: num(pi["10th_percentile"]),
          pct_90: num(pi["90th_percentile"]),
          rate_count: str(pi.count as string),
          payer_notes: str(pi.additional_payer_notes),
        }));

      yield {
        description,
        setting: str(ch.setting),
        modifiers: null,
        drug_unit: drugUnit,
        drug_type: drugType,
        gross_charge: num(ch.gross_charge),
        discounted_cash_price: num(ch.discounted_cash),
        min_negotiated_rate: num(ch.minimum),
        max_negotiated_rate: num(ch.maximum),
        generic_notes: str(ch.additional_generic_notes),
        codes,
        charges,
      };
    }
  }
}
