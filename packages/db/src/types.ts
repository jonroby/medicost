// Shared row/result shapes for the Medicost database, used by both the api
// (read) and sources (write) packages so the schema is described in one place.
// Mirrors schema.ts. Philosophy: lossless storage of the source fields; the
// "estimated dollar" for cost search is DERIVED (see CheapestCharge / the view).

// One distinct procedure at a hospital + its payer-less standard charges.
export type Procedure = {
  hospital: string;
  description: string | null;
  setting: string | null;
  modifiers: string | null;
  drug_unit: string | null;
  drug_type: string | null;
  gross_charge: number | null;
  discounted_cash_price: number | null;
  min_negotiated_rate: number | null;
  max_negotiated_rate: number | null;
  generic_notes: string | null;
};

// One of a procedure's 1..N billing codes.
export type ProcedureCode = {
  code: string;
  code_type: string | null;
};

// One payer/plan's negotiated rate for a procedure. The rate is stored raw as
// exactly one of dollar / percentage / algorithm — never collapsed.
export type Charge = {
  payer_name: string;
  plan_name: string | null;
  negotiated_dollar: number | null;
  negotiated_percentage: number | null;
  negotiated_algorithm: string | null;
  methodology: string | null;
  median_amount: number | null;
  pct_10: number | null;
  pct_90: number | null;
  rate_count: string | null;
  payer_notes: string | null;
};

// A row from the cheapest_charges view: estimated_dollar is DERIVED (raw dollar,
// else percentage × gross), with a flag for whether it was an exact dollar.
export type CheapestCharge = {
  charge_id: number;
  procedure_id: number;
  payer_id: number;
  hospital_id: number;
  estimated_dollar: number | null;
  is_exact_dollar: boolean;
  methodology: string | null;
};
