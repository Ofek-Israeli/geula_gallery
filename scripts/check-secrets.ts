/**
 * `npm run check:secrets` — secret and personal-data scanner for a PUBLIC repository (spec §7).
 *
 *   npm run check:secrets                 scan the working tree (tracked + untracked, not ignored)
 *   git log -p --format= | npm run check:secrets -- --stdin
 *                                         scan history: only added lines of the patch are checked
 *                                         (`--format=` drops the commit headers, so author e-mails
 *                                         are not reported)
 *
 * Rules:
 * - PEM blocks; token prefixes `re_` (Resend), `sk_`, `vercel_blob_rw_`, GitHub (`ghp_` …,
 *   `github_pat_`), AWS access keys, Slack, Google API keys, npm tokens;
 * - secret-like assignments (a SECRET/PASSWORD/TOKEN/API_KEY/… name given a literal of ≥ 12
 *   characters), except values starting with `e2e-`, `test-`, `dev-only-` or containing
 *   `example` / `placeholder` / `unused`; in code only quoted literals count, in `.env*`, YAML
 *   and shell files also bare `NAME=value`;
 * - the TLS-verification kill switch (`NODE_TLS_…`) in code and config files;
 * - the Cardcom public test-terminal API name, found by **SHA-256 of candidate tokens** — only
 *   the hash is in this file;
 * - e-mail addresses, phone numbers and 9-digit ID numbers in fixtures, seeds and demo data,
 *   unless allowlisted (`ALLOWLIST`);
 * - committed `.env*` files (other than `.env.example`) and key files.
 *
 * Findings print the location and the rule with the value masked; the value itself is never
 * printed. Exit code 1 when anything is found.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  /** Masked preview, never the full value. */
  preview: string;
}

/** SHA-256 of the lower-cased Cardcom public test-terminal ApiName (the name itself is not stored). */
export const CARDCOM_TEST_API_NAME_SHA256 = [
  "27e934b53f4bc420ea69bd565a54e8266ca980ed05d54df54370c85aceed870c",
];

/** Spec §7 allowlist for fixtures and seeds (unit-tested). */
export const ALLOWLIST = {
  ids: ["000000018"],
  emailDomains: ["example.com", "example.test"],
  emails: ["noreply@anthropic.com"],
  phones: ["03-000-0000", "+972-3-000-0000"],
} as const;

/**
 * Spec §7 exceptions, plus `unused` (an obviously inert dummy that is already in history:
 * `e2eAdminPassword: "unused-password"` in an M1 unit test).
 */
const ALLOWED_VALUE = /^(?:e2e-|test-|dev-only-)|example|placeholder|unused/i;

const TOKEN_RULES: { rule: string; re: RegExp }[] = [
  {
    rule: "pem-block",
    re: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PGP PRIVATE KEY BLOCK)[A-Z ]*-----/g,
  },
  { rule: "resend-key", re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{12,}\b/g },
  { rule: "sk-key", re: /\bsk_(?:live_|test_)?[A-Za-z0-9]{16,}\b/g },
  { rule: "vercel-blob-token", re: /\bvercel_blob_rw_[A-Za-z0-9_]{10,}\b/g },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { rule: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { rule: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
];

const SECRET_NAME =
  "[A-Za-z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH_?KEY|ENCRYPTION_?KEY)[A-Za-z0-9_]*";
/** `NAME = "literal"` / `NAME: 'literal'` / `"NAME": "literal"` in code and JSON. */
const QUOTED_ASSIGNMENT = new RegExp(
  `["']?\\b(${SECRET_NAME})\\b["']?\\s*[:=]\\s*(["'\`])([^"'\`\\s]{12,})\\2`,
  "gi",
);
/** `NAME=value` in env files and shell snippets; `NAME: value` in YAML. */
const ENV_ASSIGNMENT = new RegExp(
  `^\\s*(?:export\\s+)?(${SECRET_NAME})\\s*[=:]\\s*["']?([^\\s"'#]{12,})`,
  "i",
);

const TLS_KILL_SWITCH = ["NODE", "TLS", "REJECT", "UNAUTHORIZED"].join("_");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE =
  /(?<![\w.+-])(?:\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,3}|0\d{1,2}-?\d{3}-?\d{4}|\(\d{3}\)\s?\d{3}-\d{4})(?![\w-])/g;
const NINE_DIGITS = /(?<![\d.,_-])\d{9}(?![\d.,_])/g;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|toml)$|(?:^|\/)\.env[^/]*$/;
const PII_SCOPE =
  /^(?:tests\/fixtures\/|scripts\/seed\/|data\/)|(?:^|\/)fixtures?\//;
const BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|ttf|otf|woff2?|pdf|zip|gz|tgz|mp4|mov|wasm)$/i;
/** This scanner and its test describe the patterns; they are scanned with the hash rule only. */
const SELF = new Set([
  "scripts/check-secrets.ts",
  "tests/unit/check-secrets.test.ts",
]);

export function isAllowlistedEmail(email: string): boolean {
  const e = email.toLowerCase();
  if ((ALLOWLIST.emails as readonly string[]).includes(e)) return true;
  const domain = e.slice(e.lastIndexOf("@") + 1);
  return ALLOWLIST.emailDomains.some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}

export function isAllowlistedPhone(phone: string): boolean {
  return (ALLOWLIST.phones as readonly string[]).includes(phone.trim());
}

export function isAllowlistedId(id: string): boolean {
  return (ALLOWLIST.ids as readonly string[]).includes(id);
}

export function mask(value: string): string {
  const v = value.replace(/\s+/g, " ");
  if (v.length <= 6) return `${v[0] ?? ""}…(${v.length})`;
  return `${v.slice(0, 4)}…(${v.length} chars)`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface ScanOptions {
  /** Override the hashed names (tests). */
  hashedNames?: readonly string[];
}

/** Scan one file's text. `file` is the repo-relative path (decides which rules apply). */
export function scanText(
  file: string,
  text: string,
  opts: ScanOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const hashed = new Set(opts.hashedNames ?? CARDCOM_TEST_API_NAME_SHA256);
  const self = SELF.has(file);
  const code = CODE_FILE.test(file);
  const pii = PII_SCOPE.test(file);
  const add = (line: number, rule: string, value: string) =>
    findings.push({ file, line, rule, preview: mask(value) });

  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    const n = i + 1;
    // Hashed names: every alphanumeric token of plausible length.
    for (const token of lineText.match(/[A-Za-z0-9]{4,64}/g) ?? []) {
      if (hashed.has(sha256(token.toLowerCase()))) {
        add(n, "cardcom-test-api-name", token);
      }
    }
    if (self) return;
    for (const { rule, re } of TOKEN_RULES) {
      for (const m of lineText.matchAll(re)) add(n, rule, m[0]);
    }
    for (const m of lineText.matchAll(QUOTED_ASSIGNMENT)) {
      const value = m[3] ?? "";
      // Env-var *names* (e.g. "BLOB_READ_WRITE_TOKEN" in an error message) are not values.
      const isVarName = /^[A-Z][A-Z0-9_]+$/.test(value);
      if (
        !isVarName &&
        !ALLOWED_VALUE.test(value) &&
        !/^\$\{|^process\.env/.test(value)
      ) {
        add(n, "secret-assignment", value);
      }
    }
    const env = ENV_ASSIGNMENT.exec(lineText);
    if (env && !/[`"']\s*$/.test(lineText.slice(0, env.index))) {
      const value = env[2] ?? "";
      // `${VAR}` / `${{ secrets.X }}` references are not values.
      const looksLikeCode = /^\$/.test(value);
      const isEnvFile = /(?:^|\/)\.env[^/]*$|\.ya?ml$|\.sh$/.test(file);
      if (isEnvFile && !looksLikeCode && !ALLOWED_VALUE.test(value)) {
        add(n, "secret-assignment", value);
      }
    }
    if (code && lineText.includes(TLS_KILL_SWITCH)) {
      add(n, "tls-verification-disabled", TLS_KILL_SWITCH);
    }
    if (pii) {
      for (const m of lineText.matchAll(EMAIL)) {
        if (!isAllowlistedEmail(m[0])) add(n, "pii-email", m[0]);
      }
      for (const m of lineText.matchAll(PHONE)) {
        // A bare 9-digit run is judged by the ID rule below (e.g. the allowlisted 000000018).
        if (/^\d{9}$/.test(m[0])) continue;
        if (!isAllowlistedPhone(m[0])) add(n, "pii-phone", m[0]);
      }
      for (const m of lineText.matchAll(NINE_DIGITS)) {
        if (!isAllowlistedId(m[0])) add(n, "pii-id-number", m[0]);
      }
    }
  });
  return findings;
}

/** File names that must never be committed. */
export function scanPath(file: string): Finding[] {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (/^\.env/.test(base) && base !== ".env.example") {
    return [{ file, line: 0, rule: "env-file", preview: base }];
  }
  if (
    /\.(?:pem|key|p12|pfx)$/i.test(base) ||
    /^id_(?:rsa|ed25519|ecdsa)$/.test(base)
  ) {
    return [{ file, line: 0, rule: "key-file", preview: base }];
  }
  return [];
}

/** Scan a unified diff (`git log -p --format=`): only added lines, attributed to their file. */
export function scanPatch(patch: string, opts: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  let file = "";
  let added: string[] = [];
  const flush = () => {
    if (file && added.length > 0 && !BINARY.test(file)) {
      findings.push(...scanText(file, added.join("\n"), opts));
    }
    added = [];
  };
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      file = "";
    } else if (line.startsWith("+++ ")) {
      flush();
      const target = line.slice(4).trim();
      file = target === "/dev/null" ? "" : target.replace(/^b\//, "");
      if (file) findings.push(...scanPath(file));
    } else if (line.startsWith("+") && file) {
      added.push(line.slice(1));
    }
  }
  flush();
  // Line numbers inside a history patch are not meaningful; report 0.
  return findings.map((f) => ({ ...f, line: 0 }));
}

function workingTreeFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => !/ \d+(?:\.[^/]*)?$/.test(f)); // file-sync duplicates ("name 2.ts")
}

function scanWorkingTree(): { files: number; findings: Finding[] } {
  const findings: Finding[] = [];
  let files = 0;
  for (const file of workingTreeFiles()) {
    findings.push(...scanPath(file));
    if (BINARY.test(file)) continue;
    let text: string;
    try {
      if (statSync(file).size > 8 * 1024 * 1024) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    files += 1;
    findings.push(...scanText(file, text));
  }
  return { files, findings };
}

function report(findings: Finding[], scanned: string): never {
  if (findings.length === 0) {
    console.log(`[check:secrets] clean (${scanned})`);
    process.exit(0);
  }
  console.error(`[check:secrets] ${findings.length} finding(s) in ${scanned}:`);
  for (const f of findings) {
    const where = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    console.error(`  ${where}  ${f.rule}  ${f.preview}`);
  }
  console.error(
    "Remove the value (use .env.local, a placeholder, or an allowlisted test value) and re-run.",
  );
  process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  if (process.argv.includes("--stdin")) {
    const patch = readFileSync(0, "utf8");
    report(scanPatch(patch), "history patch from stdin");
  } else {
    const { files, findings } = scanWorkingTree();
    report(findings, `${files} files`);
  }
}
