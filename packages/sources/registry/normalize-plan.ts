// Conservative plan-string normalizer. Shared by the mapping builder.
//
// Philosophy (per project owner): collapse ONLY provably-identical plan strings.
// Never merge two genuinely different plans — a user searching their plan must
// get THEIR plan, not a blob. When uncertain, keep separate.
//
// Merges applied (all mechanically safe — same plan, different spelling):
//   - case / whitespace / punctuation noise
//   - per-hospital campus suffixes ( - Bi / - Msq / - Slw / - Tmsh / - Brook / - Nyeei )
//   - trailing internal plan codes (1010, T66, U01, VDR, 3853, Chz, Tao ...)
//   - same word-set in different order (HMO/POS/PPO == HMO/PPO/POS)

const CAMPUS = /\s*[-–]\s*(Bi|Msq|Slw|Tmsh|Brook|Nyeei)\b/gi;

// A trailing token that looks like an internal plan code, not a real word.
// Codes seen: T66, U01, 1010, VDR, Chz, Tao, Tam, Cgs, Ubd. These trail an
// otherwise-complete plan name. A short (<=4) alnum token with a digit, or a
// <=3-char all-letter token, is treated as a code. Common real short words are
// whitelisted so we don't eat them.
const REAL_SHORT_WORDS = new Set([
  "ppo", "hmo", "epo", "pos", "chp", "snp", "map", "the", "and", "non", "all",
  "gold", "leaf", "plus", "map", "ma", "hiv", "fhp", "ny", "ob",
]);
function isCodeTail(tok: string): boolean {
  const t = tok.toLowerCase();
  if (REAL_SHORT_WORDS.has(t)) return false;
  if (tok.length > 4) return false;
  // A bare 1-2 digit number ("2", "4") is usually meaningful ("1 & 2"), NOT a
  // code — don't strip it. Codes are longer alphanumerics (T66, U01, 1010, VDR).
  if (/^\d{1,2}$/.test(tok)) return false;
  if (/\d/.test(tok)) return true; // T66, U01, 1010, VDR, 3853
  return tok.length <= 3 && /^[a-z]+$/i.test(tok); // Tao, Tam, Ubd, Cgs, Chz
}

// V1 display cleanups: fix obvious source typos / abbreviations in the DISPLAY
// name. Applied so the canonical name reads cleanly. IMPORTANT: this only changes
// how a plan is DISPLAYED — the raw→canonical mapping (which raw strings resolve
// here) is preserved by build-payer-mapping.ts regardless of the display string.
const DISPLAY_FIXES: Array<[RegExp, string]> = [
  [/\bcommecial\b/gi, "Commercial"],
  [/\bbhavioral\b/gi, "Behavioral"],
  [/\bbehviorl\b/gi, "Behavioral"],
  [/\bessntl\b/gi, "Essential"],
  [/\blvls?\b/gi, "Levels"],
  [/\bntwk\b/gi, "Network"],
  [/\b(\d)and(\d)\b/gi, "$1 & $2"], // 1and2 -> 1 & 2
  [/\boap\b/gi, "Open Access"],
  [/^by\s+/i, ""], // leading "By Molina ..." fragment from company-strip
  [/^[-+]\s*/, ""], // leading "+ Oscar" / "- Humana" co-brand fragment
];

function applyDisplayFixes(s: string): string {
  let x = s;
  for (const [re, to] of DISPLAY_FIXES) x = x.replace(re, to);
  return x.replace(/\s+/g, " ").trim();
}

// Tidy display form (Title-ish, acronyms preserved).
function tidy(s: string): string {
  let x = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const acr: Record<string, string> = {
    Hmo: "HMO", Ppo: "PPO", Epo: "EPO", Pos: "POS", Chp: "CHP", Harp: "HARP",
    Snp: "SNP", Map: "MAP", Mltc: "MLTC", Dsnp: "DSNP", Tpa: "TPA", Ny: "NY",
    Nyc: "NYC", Fida: "FIDA", Fhp: "FHP", Hiv: "HIV", Bcbs: "BCBS", Ghi: "GHI",
    Hip: "HIP", Pcp: "PCP", Pcps: "PCPs", Ob: "OB", Gyn: "GYN", Pos: "POS",
  };
  for (const [k, v] of Object.entries(acr)) {
    x = x.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  }
  return x;
}

// Strip a leading repeat of the company name from a plan (the bucket already
// holds the company): company "Aetna", plan "Aetna PPO" -> "PPO". Uses the
// company's first significant word so "Anthem / Empire BCBS" still strips "Anthem".
function stripCompany(plan: string, company: string): string {
  const co = company.split(/[\s/(]/)[0];
  if (!co) return plan;
  const re = new RegExp(`^${co.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
  return plan.replace(re, "").trim();
}

// Display string for a plan (after the safe cleanups, before order-folding).
// `company` (optional) strips a redundant leading company name.
export function displayPlan(raw: string, company = ""): string {
  let x = raw.replace(/&amp;/gi, "&");
  x = x.replace(CAMPUS, "");
  // strip a single trailing code tail
  const toks = x.replace(/\s+/g, " ").trim().split(" ");
  if (toks.length > 1 && isCodeTail(toks[toks.length - 1]!)) toks.pop();
  x = toks.join(" ").replace(/\s*[-–]\s*/g, " - ").replace(/\s+/g, " ").trim();
  let disp = tidy(x);
  if (company) disp = stripCompany(disp, company);
  disp = applyDisplayFixes(disp);
  return disp || "(Unspecified)";
}

// Comparison key: two raw plans are "provably identical" iff equal keys. Folds
// case/punctuation AND sorts the word-set so reorderings match.
export function planKey(raw: string, company = ""): string {
  const disp = displayPlan(raw, company).toLowerCase();
  const words = disp.replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
  return words.sort().join(" ");
}
