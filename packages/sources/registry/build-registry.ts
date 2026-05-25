// Builds the NYC hospital fetch registry from the NYS DOH roster.
//
// Two-stage design (see memory two-stage-fetch-parse): this produces the Stage-1
// input — one entry per hospital with the DURABLE cms-hpt.txt URL plus a
// location_match string used to pick that hospital's mrf-url out of the txt.
//
// We map each DOH `operator_name` to its system's cms-hpt.txt (operator_name is
// the reliable system grouping; facility_name varies). Hospitals whose system
// cms-hpt.txt we've confirmed get status "resolved"; the rest are "todo" with a
// note so a human/agent can fill the cms_hpt_url later.
//
//   bun run registry/build-registry.ts   # writes registry/nyc-registry.json

type DohRow = {
  fac_id: string;
  facility_name: string;
  address1: string;
  city: string;
  county: string;
  fac_zip: string;
  operator_name: string;
  ownership_type: string;
};

// operator_name -> the system's confirmed cms-hpt.txt URL. Confirmed by probing
// 2026-05-24 (HPT-OK = body had location-name/mrf-url lines).
const OPERATOR_HPT: Record<string, string> = {
  "New York City Health and Hospitals Corporation": "https://www.nychealthandhospitals.org/cms-hpt.txt",
  "Montefiore Medical Center": "https://montefioreeinstein.org/cms-hpt.txt",
  "The Mount Sinai Hospital": "https://www.mountsinai.org/cms-hpt.txt",
  "Beth Israel Medical Center Inc": "https://www.mountsinai.org/cms-hpt.txt", // MS Brooklyn + MS Behavioral
  "St Lukes Roosevelt Hospital Center Inc": "https://www.mountsinai.org/cms-hpt.txt", // MS Morningside + West
  "NY Eye and Ear Infirmary Inc": "https://www.mountsinai.org/cms-hpt.txt",
  "The New York and Presbyterian Hospital": "https://www.nyp.org/cms-hpt.txt",
  "NewYork-Presbyterian/Queens": "https://www.nyp.org/cms-hpt.txt",
  "NYU Langone Hospitals": "https://nyulangone.org/cms-hpt.txt",
  "Memorial Hospital for Cancer and Allied Diseases Inc": "https://www.mskcc.org/cms-hpt.txt",
  "Lenox Hill Hospital": "https://lenoxhill.northwell.edu/cms-hpt.txt", // Northwell (Lenox Hill + Greenwich Village)
  "Staten Island University Hospital": "https://lenoxhill.northwell.edu/cms-hpt.txt", // Northwell
  "BronxCare Health System": "https://www.bronxcare.org/cms-hpt.txt",
  "Maimonides Medical Center": "https://www.maimonidesmedical.org/cms-hpt.txt",
  "The Brookdale Hospital Medical Center": "https://onebrooklynhealth.org/cms-hpt.txt", // Brookdale + Interfaith + Kingsbrook
  "St Barnabas Hospital Inc": "https://sbhny.org/cms-hpt.txt",
  "Calvary Hospital Inc.": "https://calvaryhospital.org/cms-hpt.txt",
  "Flushing Hospital and Medical Center Inc": "https://flushinghospital.org/cms-hpt.txt",
  "Jamaica Hospital Inc": "https://jamaicahospital.org/cms-hpt.txt",
  "Episcopal Health Services Inc": "https://ehs.org/cms-hpt.txt",
  "Richmond University Medical Center": "https://www.rumcsi.org/cms-hpt.txt",
  "NY Society for the Relief of The Ruptured & Crippled": "https://www.hss.edu/cms-hpt.txt",
  "The Rockefeller University Inc": "https://www.rockefeller.edu/cms-hpt.txt",
  "The Brooklyn Hospital Center": "https://www.brooklynhospital.org/cms-hpt.txt",
  "State of New York": "https://www.downstate.edu/cms-hpt.txt", // SUNY Downstate / University Hospital of Brooklyn
  "Long Island Jewish Medical Center": "https://lij.northwell.edu/cms-hpt.txt", // Northwell
  "The New York Community Hospital of Brooklyn, Inc.": "https://nych.com/cms-hpt.txt", // Maimonides Midwood
  // --- not yet resolved (no cms-hpt.txt found at guessed domains) ---
  // "Wyckoff Heights Medical Center": cms-hpt.txt not at wyckoffhospital.com (404); needs manual lookup
};

// Kebab-case slug from a facility name (used for selection display + raw filenames).
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const roster: DohRow[] = JSON.parse(
  await Bun.file(`${import.meta.dir}/nyc-doh-roster.json`).text(),
);

// Dedup on fac_id (the DOH export repeats some rows verbatim).
const byId = new Map<string, DohRow>();
for (const r of roster) if (!byId.has(r.fac_id)) byId.set(r.fac_id, r);

// Track slugs so collisions get a -fac_id suffix rather than clobbering.
const slugCounts = new Map<string, number>();
for (const r of byId.values()) {
  const s = slugify(r.facility_name);
  slugCounts.set(s, (slugCounts.get(s) ?? 0) + 1);
}

const registry = [...byId.values()].map((r) => {
  const cms_hpt_url = OPERATOR_HPT[r.operator_name] ?? null;
  const base = slugify(r.facility_name);
  const slug = (slugCounts.get(base) ?? 0) > 1 ? `${base}-${r.fac_id}` : base;
  return {
    fac_id: r.fac_id,
    slug,
    name: r.facility_name,
    borough: r.county,
    address: r.address1,
    zip: r.fac_zip,
    operator: r.operator_name,
    cms_hpt_url,
    // location_match: filled per-hospital later — the location-name in the
    // cms-hpt.txt rarely equals the DOH facility_name. Default to a best guess.
    location_match: r.facility_name,
    status: cms_hpt_url ? "resolved" : "todo",
  };
});

// Preserve any ingest-tracking fields already recorded (ingest.ts writes
// ingested_at / counts back into the registry), so a rebuild from the DOH
// roster doesn't wipe them. Carry them over by fac_id.
const REG_PATH = `${import.meta.dir}/nyc-registry.json`;
const INGEST_FIELDS = [
  "ingested_at",
  "ingested_file",
  "ingested_procedures",
  "ingested_charges",
] as const;
let prior: Record<string, Record<string, unknown>> = {};
if (await Bun.file(REG_PATH).exists()) {
  for (const h of JSON.parse(await Bun.file(REG_PATH).text()) as Array<
    Record<string, unknown>
  >) {
    prior[h.fac_id as string] = h;
  }
}
for (const h of registry as Array<Record<string, unknown>>) {
  const old = prior[h.fac_id as string];
  if (old) for (const f of INGEST_FIELDS) if (f in old) h[f] = old[f];
}

await Bun.write(REG_PATH, JSON.stringify(registry, null, 2) + "\n");

const resolved = registry.filter((h) => h.status === "resolved").length;
console.log(
  `Wrote ${registry.length} hospitals (${byId.size} unique fac_ids): ` +
    `${resolved} resolved, ${registry.length - resolved} todo.`,
);
for (const h of registry.filter((x) => x.status === "todo")) {
  console.log(`  TODO: ${h.name} — operator "${h.operator}"`);
}
