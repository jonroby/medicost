// Shared row/result shapes for the Medicost database, used by both the api
// (read) and sources (write) packages so the schema is described in one place.

// A "procedure" is a distinct (hospital, code, description, setting) group.
export type Proc = {
  hospital: string;
  description: string;
  billing_code: string | null;
  billing_code_type: string | null;
  setting: string | null;
};

// One payer/plan's negotiated rate for a procedure.
export type Rate = {
  name: string;
  plan_name: string | null;
  negotiated_rate: number;
};
