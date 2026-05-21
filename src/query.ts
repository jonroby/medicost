// Search the Medicost database from the CLI.
//
//   bun run src/query.ts search "MRI knee"   -> LIKE search on description
//   bun run src/query.ts code 73721          -> exact billing code search
//
// For each matching procedure we print: description, hospital, cash price,
// and every payer's negotiated rate sorted low to high.

import { Database } from "bun:sqlite";

const DB_PATH = process.env.MEDICOST_DB ?? "medicost.db";
const [mode, ...rest] = process.argv.slice(2);
const term = rest.join(" ").trim();

if ((mode !== "search" && mode !== "code") || !term) {
  console.error('Usage:\n  bun run src/query.ts search "MRI knee"\n  bun run src/query.ts code 73721');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

type ProcRow = {
  hospital: string;
  description: string;
  billing_code: string | null;
  billing_code_type: string | null;
  setting: string | null;
};

// A "procedure" is a (hospital, code, description, setting) group. Find the
// distinct ones that match, then list their cash price + payer rates.
const where =
  mode === "code" ? "c.billing_code = ?" : "c.description LIKE ?";
const arg = mode === "code" ? term : `%${term}%`;

const procs = db
  .query<ProcRow, [string]>(
    `SELECT DISTINCT h.name AS hospital, c.description, c.billing_code,
            c.billing_code_type, c.setting
       FROM charges c
       JOIN hospitals h ON h.id = c.hospital_id
      WHERE ${where}
      ORDER BY c.description, c.setting
      LIMIT 50`,
  )
  .all(arg);

if (procs.length === 0) {
  console.log(`No matches for ${mode} "${term}".`);
  db.close();
  process.exit(0);
}

const cashStmt = db.query<{ discounted_cash_price: number | null; gross_charge: number | null }, any[]>(
  `SELECT discounted_cash_price, gross_charge FROM charges
    WHERE hospital_id = (SELECT id FROM hospitals WHERE name = ?)
      AND description = ? AND IFNULL(setting,'') = IFNULL(?,'')
      AND IFNULL(billing_code,'') = IFNULL(?,'')
      AND payer_id IS NULL LIMIT 1`,
);

const ratesStmt = db.query<{ name: string; plan_name: string | null; negotiated_rate: number }, any[]>(
  `SELECT p.name, p.plan_name, c.negotiated_rate
     FROM charges c JOIN payers p ON p.id = c.payer_id
    WHERE c.hospital_id = (SELECT id FROM hospitals WHERE name = ?)
      AND c.description = ? AND IFNULL(c.setting,'') = IFNULL(?,'')
      AND IFNULL(c.billing_code,'') = IFNULL(?,'')
      AND c.negotiated_rate IS NOT NULL
    ORDER BY c.negotiated_rate ASC`,
);

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

for (const p of procs) {
  const code = p.billing_code ? `${p.billing_code}${p.billing_code_type ? ` (${p.billing_code_type})` : ""}` : "no code";
  const setting = p.setting ? ` · ${p.setting}` : "";
  console.log("\n" + "─".repeat(72));
  console.log(`${p.description}  [${code}]${setting}`);
  console.log(`${p.hospital}`);

  const cash = cashStmt.get(p.hospital, p.description, p.setting, p.billing_code);
  console.log(`  Cash price: ${money(cash?.discounted_cash_price)}   (gross ${money(cash?.gross_charge)})`);

  const rates = ratesStmt.all(p.hospital, p.description, p.setting, p.billing_code);
  if (rates.length === 0) {
    console.log("  No payer-specific negotiated rates.");
    continue;
  }
  console.log(`  Payer rates (low → high), ${rates.length} plans:`);
  for (const r of rates) {
    const plan = r.plan_name ? ` — ${r.plan_name}` : "";
    console.log(`    ${money(r.negotiated_rate).padStart(12)}  ${r.name}${plan}`);
  }
}

console.log("\n" + "─".repeat(72));
console.log(`${procs.length} procedure(s) shown${procs.length === 50 ? " (capped at 50)" : ""}.`);
db.close();
