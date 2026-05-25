// Build the EXHAUSTIVE raw → normalized payer mapping.
//
// Every distinct raw (name, plan_name) pair in the DB must map to a normalized
// { company, plan } — nothing falls through. A later ingest/condense script reads
// this table to translate raw payer strings into the standardized form.
//
//   DATABASE_URL=postgres://localhost/medicost bun run registry/build-payer-mapping.ts
//
// Produces registry/payer-mapping.json (raw→{company, plan, plan_key}) and the
// human-editable registry/canonical-payers.tsv; prints coverage (must be 100%).

import { sql } from "@medicost/db";
import { displayPlan, planKey } from "./normalize-plan.ts";

// --- company resolution: raw payer name -> canonical company (pass-1 buckets) ---
// First matching rule wins; unmatched names fall back to a cleaned version of
// themselves (so coverage is always 100%).
const COMPANY_RULES: Array<[string, RegExp]> = [
  ["UnitedHealthcare", /^(uhc|united|optum|oxford)\b|unitedhealthcare|uhc\/oxford/i],
  ["Aetna", /^aetna|meritain/i],
  ["Anthem / Empire BCBS", /^anthem|^empire|^bcbs|bluecr|blue ?cross|bcbc/i],
  ["EmblemHealth", /^emblem|^ghi\b|^hip\b/i],
  ["Healthfirst", /^healthfirst|^health ?first/i],
  ["MetroPlus", /^metroplus/i],
  ["Fidelis", /^fidelis/i],
  ["Cigna", /^cigna/i],
  ["Affinity (Molina)", /^affinity|molina/i],
  ["MultiPlan", /^magna|claritev|multiplan/i],
  ["1199 SEIU", /^1199|seiu1199|local 1199/i],
  ["Amida Care", /^amida|carelon/i],
  ["VNS Health", /^vns|visiting nurse/i],
  ["Wellcare", /^wellcare/i],
  ["Humana", /^humana/i],
  ["Oscar", /^oscar/i],
  ["MVP", /^mvp/i],
  ["Centerlight", /^centerlight/i],
  ["Centers Plan for Healthy Living", /^centers ?pl/i],
  ["Elderplan", /^elderplan/i],
  ["VillageCareMAX", /^village ?care/i],
  ["Medicare", /^medicare$/i],
  ["Medicaid", /^medicaid$|new york medicaid/i],
  ["Healthplus", /^healthplus|^health ?plus/i],
  ["Empire Plan (NYSHIP)", /empire plan|nyship/i],
  ["Northwell", /^northwell/i],
  ["Beech Street", /^beech ?str/i],
  ["First Health", /^first health/i],
  ["Senior Whole Health", /senior whole health/i],
  ["Agewell", /^agewell/i],
  ["ArchCare", /^archcare/i],
  ["Hamaspik", /^hamaspik/i],
  ["Longevity", /^longevity/i],
  ["NY Hotel Trades", /hotel trade/i],
  ["Senior Health Partners", /senior health partners/i],
  ["Partners Health Plan", /partners health plan/i],
  ["Veterans Affairs", /veterans affairs/i],
  ["Beacon", /^beacon/i],
  ["ValueOptions", /valueoptions/i],
  ["Somos", /^somos/i],
  ["Centivo", /^centivo/i],
  ["Horizon", /^horizon/i],
  ["Devon", /^devon/i],
  ["Point Comfort", /^point comfort/i],
  ["Christian Brothers", /christian brothers/i],
  ["Nippon Life", /nippon/i],
  ["Nat Assoc Letter Carriers", /letter carriers/i],
  ["6 Degrees Health", /6 degrees/i],
  ["Consumer Health Network", /consumer health/i],
  ["QHM", /^qhm/i],
  ["URN", /^urn/i],
  ["VACCN", /^vaccn/i],
  ["Worldwide", /^worldwide/i],
  ["Block Vision", /block vision/i],
  ["Davis Vision", /davis vision/i],
];

// Title-case with known acronyms preserved.
function titleCase(s: string): string {
  let x = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const acr: Record<string, string> = {
    Hmo: "HMO", Ppo: "PPO", Epo: "EPO", Pos: "POS", Chp: "CHP", Harp: "HARP",
    Snp: "SNP", Map: "MAP", Mltc: "MLTC", Dsnp: "DSNP", Tpa: "TPA", Ny: "NY",
    Nyc: "NYC", Fida: "FIDA", Fhp: "FHP", Hiv: "HIV", Bcbs: "BCBS", Ghi: "GHI",
    Hip: "HIP", Pcp: "PCP", Pcps: "PCPs", Mcr: "Medicare", Mcd: "Medicaid",
    Com: "Commercial", Ob: "OB", Gyn: "GYN",
  };
  for (const [k, v] of Object.entries(acr)) {
    x = x.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  }
  return x;
}

function resolveCompany(name: string): string {
  const hit = COMPANY_RULES.find(([, re]) => re.test(name));
  if (hit) return hit[0];
  return titleCase(stripCodes(name));
}

// Strip trailing plan codes (T66, U01, 1010, VDR, 3853) and campus suffixes.
function stripCodes(s: string): string {
  return s
    .replace(/\s*&amp;\s*/gi, " & ")
    .replace(/\s+[-–]?\s*(Bi|Msq|Slw|Tmsh|Brook|Nyeei)\b/gi, "")
    .replace(/\b[A-Z]{1,3}\d{1,4}\b/g, "")
    .replace(/\b\d{3,4}\b/g, "")
    .replace(/[_|]+/g, " ")
    .replace(/\s*[-–]\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

// The plan source: plan_name unless it's a vague category code (COM/MCR/MCD/MCA)
// or blank, in which case the plan detail is in the name field instead.
function planSource(rawName: string, rawPlan: string): string {
  if (rawPlan === "" || /^(com|mcr|mcd|mca)$/i.test(rawPlan)) return rawName;
  return rawPlan;
}

// Pull every distinct raw (name, plan_name) pair straight from the DB so the
// script is self-contained (DATABASE_URL, default local medicost).
const pairs = (await sql`
  SELECT DISTINCT name, COALESCE(plan_name, '') AS plan FROM payers
`).map((r: { name: string; plan: string }) => ({ name: r.name, plan: r.plan }));

// Each raw pair -> { company, plan (display), plan_key (merge key) }.
const mapping = pairs.map(({ name, plan }) => {
  const company = resolveCompany(name);
  const src = planSource(name, plan);
  return {
    raw_name: name,
    raw_plan: plan,
    company,
    plan: displayPlan(src, company),
    plan_key: company + "::" + planKey(src, company),
  };
});

await Bun.write(
  `${import.meta.dir}/payer-mapping.json`,
  JSON.stringify(mapping, null, 2) + "\n",
);

// Also (re)generate the human-editable canonical view, derived from the mapping.
const canonRows = new Map<string, { company: string; plan: string; n: number }>();
for (const m of mapping) {
  const e = canonRows.get(m.plan_key) ?? { company: m.company, plan: m.plan, n: 0 };
  e.n++;
  canonRows.set(m.plan_key, e);
}
const sorted = [...canonRows.values()].sort(
  (a, b) => a.company.localeCompare(b.company) || a.plan.localeCompare(b.plan),
);
let tsv =
  "# Canonical payers (company, plan, #raw_variants). Derived from payer-mapping.json.\n" +
  "# The raw→canonical linkage lives in payer-mapping.json — do not lose it.\n";
let last = "";
for (const e of sorted) {
  if (e.company !== last) { tsv += "\n"; last = e.company; }
  tsv += `${e.company}\t${e.plan}\t${e.n}\n`;
}
await Bun.write(`${import.meta.dir}/canonical-payers.tsv`, tsv);

// Coverage + summary.
const companies = new Set(mapping.map((m) => m.company));
console.log(`Mapped ${mapping.length}/${pairs.length} raw pairs (must equal).`);
console.log(`${companies.size} companies, ${canonRows.size} canonical (company, plan) entries.`);

await sql.end();
