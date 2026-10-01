/**
 * `npm run gen:api-types` (spec §4.1): downloads each provider's OpenAPI document into `openapi/`
 * (gitignored), runs openapi-typescript 7.13.0 on it and writes
 * `src/server/integrations/generated/<name>.ts` (committed) with a header recording the source URL,
 * the spec version and the sha256 of the downloaded document.
 *
 * Usage:
 *   npm run gen:api-types                 # every provider
 *   npm run gen:api-types -- cardcom dhl  # only these
 *
 * DHL: tries `DHL_OPENAPI_URL`, then the 3.3.2 YAML, then whatever `dpdhl-express-api-*.yaml` the
 * developer.dhl.com reference page links to, then the 2.7.2 YAML. If none is reachable the existing
 * generated file (or the hand-written minimal fallback) is kept and the script says so.
 *
 * Post-processing: every comment (the JSDoc descriptions, examples and deprecation notes copied from
 * the provider documents) is stripped by re-printing the output through the TypeScript printer
 * with `removeComments`. Only our short provenance header is kept. This keeps the committed files
 * small and free of third-party prose; the types themselves are unchanged.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";

const ROOT = process.cwd();
const DOWNLOAD_DIR = path.join(ROOT, "openapi");
const OUT_DIR = path.join(ROOT, "src/server/integrations/generated");
const USER_AGENT =
  "geula-gallery-gen-api-types (https://github.com/Ofek-Israeli/geula_gallery)";

const PAYPAL_RAW =
  "https://raw.githubusercontent.com/paypal/paypal-rest-api-specifications/main/openapi";
const DHL_PAGE =
  "https://developer.dhl.com/api-reference/dhl-express-mydhl-api";
const DHL_BASE = "https://developer.dhl.com";

interface Source {
  name: string;
  title: string;
  /** Candidate URLs, tried in order (a function may discover more at runtime). */
  urls: () => Promise<string[]>;
  ext: "json" | "yaml";
  /** Repairs known upstream defects before parsing. */
  sanitize?: (text: string) => string;
}

/** Cardcom's swagger has at times contained invalid JSON escapes (e.g. `\d` in descriptions). */
function sanitizeJsonBackslashes(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  }
}

async function discoverDhlYaml(): Promise<string[]> {
  try {
    const res = await fetch(DHL_PAGE, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const links = [
      ...html.matchAll(
        /\/sites\/default\/files\/[^"' ]*dpdhl-express-api-[\d.]+\.yaml/g,
      ),
    ].map((m) => `${DHL_BASE}${m[0]}`);
    return [...new Set(links)];
  } catch {
    return [];
  }
}

const SOURCES: Source[] = [
  {
    name: "cardcom",
    title: "Cardcom API v11",
    ext: "json",
    urls: async () => [
      "https://secure.cardcom.solutions/swagger/v11/swagger.json",
    ],
    sanitize: sanitizeJsonBackslashes,
  },
  {
    name: "paypal-checkout-orders-v2",
    title: "PayPal Orders v2",
    ext: "json",
    urls: async () => [`${PAYPAL_RAW}/checkout_orders_v2.json`],
  },
  {
    name: "paypal-payments-v2",
    title: "PayPal Payments v2",
    ext: "json",
    urls: async () => [`${PAYPAL_RAW}/payments_payment_v2.json`],
  },
  {
    name: "paypal-webhooks-v1",
    title: "PayPal Webhooks v1",
    ext: "json",
    urls: async () => [`${PAYPAL_RAW}/notifications_webhooks_v1.json`],
  },
  {
    name: "morning",
    title: "Morning (Green Invoice) API",
    ext: "json",
    urls: async () => [
      "https://developers.morning.co/docs/openapi.bundled.json",
    ],
  },
  {
    name: "dhl-mydhl",
    title: "DHL Express MyDHL API",
    ext: "yaml",
    urls: async () => {
      const fromEnv = process.env.DHL_OPENAPI_URL?.trim();
      const discovered = await discoverDhlYaml();
      return [
        ...(fromEnv ? [fromEnv] : []),
        `${DHL_BASE}/sites/default/files/2026-09/dpdhl-express-api-3.3.2.yaml`,
        ...discovered,
        `${DHL_BASE}/sites/default/files/2024-03/dpdhl-express-api-2.7.2.yaml`,
      ].filter((u, i, all) => all.indexOf(u) === i);
    },
  },
];

async function download(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error("got an HTML page instead of an OpenAPI document");
  }
  return text;
}

function specVersion(text: string, ext: "json" | "yaml"): string {
  if (ext === "json") {
    try {
      const doc = JSON.parse(text) as {
        info?: { version?: string };
        openapi?: string;
        swagger?: string;
      };
      return `${doc.info?.version ?? "unknown"} (OpenAPI ${doc.openapi ?? doc.swagger ?? "?"})`;
    } catch {
      return "unknown";
    }
  }
  // JS `.` does not match `\r`, so normalise CRLF (the DHL YAML uses it) first.
  const yaml = text.replace(/\r\n?/g, "\n");
  const info = /^info:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(yaml)?.[1] ?? "";
  const version = /^[ \t]+version:\s*['"]?([^'"\n]+)['"]?/m.exec(info)?.[1];
  const openapi = /^openapi:\s*['"]?([^'"\n]+)['"]?/m.exec(yaml)?.[1];
  return `${version?.trim() ?? "unknown"} (OpenAPI ${openapi?.trim() ?? "?"})`;
}

/**
 * Re-prints TypeScript source without any comments. Uses the compiler's scanner/printer rather than
 * a regex, so string-literal keys such as `"*\/*"` (content types) are left intact.
 */
export function stripComments(source: string): string {
  const file = ts.createSourceFile(
    "generated.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  return printer.printFile(file);
}

async function generate(source: Source): Promise<"ok" | "kept" | "failed"> {
  const outFile = path.join(OUT_DIR, `${source.name}.ts`);
  const candidates = await source.urls();
  const errors: string[] = [];
  for (const url of candidates) {
    let text: string;
    try {
      text = await download(url);
    } catch (error) {
      errors.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    if (source.sanitize) text = source.sanitize(text);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const file = path.join(DOWNLOAD_DIR, `${source.name}.${source.ext}`);
    await writeFile(file, text);
    let body: string;
    try {
      const ast = await openapiTS(pathToFileURL(file), {
        silent: true,
        alphabetize: false,
      });
      body = stripComments(astToString(ast));
    } catch (error) {
      errors.push(`${url}: openapi-typescript: ${(error as Error).message}`);
      continue;
    }
    const header = [
      "/**",
      ` * ${source.title}: generated by \`npm run gen:api-types\` (openapi-typescript 7.13.0).`,
      " * Do not edit by hand; re-run the generator instead.",
      " *",
      ` * Source:  ${url}`,
      ` * Version: ${specVersion(text, source.ext)}`,
      ` * SHA-256: ${sha256}`,
      " */",
      "",
    ].join("\n");
    await writeFile(outFile, `${header}${body}`);
    console.log(
      `[gen:api-types] ${source.name}: ${specVersion(text, source.ext)} from ${url}`,
    );
    return "ok";
  }
  for (const e of errors) console.warn(`[gen:api-types] ${source.name}: ${e}`);
  if (existsSync(outFile)) {
    const head = (await readFile(outFile, "utf8")).split("\n", 8).join("\n");
    console.warn(
      `[gen:api-types] ${source.name}: every source failed; keeping the existing file:\n${head}`,
    );
    return "kept";
  }
  console.error(
    `[gen:api-types] ${source.name}: every source failed and no file exists.`,
  );
  return "failed";
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = only.length
  ? SOURCES.filter(
      (s) => only.includes(s.name) || only.some((o) => s.name.startsWith(o)),
    )
  : SOURCES;
if (selected.length === 0) {
  console.error(
    `[gen:api-types] unknown source(s): ${only.join(", ")}. Known: ${SOURCES.map((s) => s.name).join(", ")}`,
  );
  process.exit(1);
}

await mkdir(DOWNLOAD_DIR, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

let failed = 0;
for (const source of selected) {
  const result = await generate(source);
  if (result === "failed") failed++;
}
process.exit(failed > 0 ? 1 : 0);
