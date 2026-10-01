import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Layer rules of spec §2.2, enforced on the source tree. Imports and `process.env` reads are
 * found with the TypeScript parser (comments and strings that merely mention them do not
 * count). Each rule reports every offending file, so a failure lists everything to fix.
 */

const ROOT = process.cwd();
const posix = (p: string) => p.split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    // File-sync duplicates ("name 2.ts") are not part of the project.
    if (/ \d+(\.[a-z]+)?$/.test(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
}

const GENERATED = "src/server/integrations/generated/";

const files = (dir: string) =>
  walk(join(ROOT, dir))
    .map((f) => posix(relative(ROOT, f)))
    .filter((f) => !f.startsWith(GENERATED))
    .sort();

const SRC = files("src");
const SCRIPTS = files("scripts");

interface Parsed {
  source: ts.SourceFile;
  imports: string[];
  readsProcessEnv: boolean;
  calls: Set<string>;
  strings: string[];
}

const cache = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const hit = cache.get(file);
  if (hit) return hit;
  const text = readFileSync(join(ROOT, file), "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: string[] = [];
  const calls = new Set<string>();
  const strings: string[] = [];
  let readsProcessEnv = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "env" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process"
    ) {
      readsProcessEnv = true;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) calls.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee))
        calls.add(callee.name.text);
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      strings.push(node.text);
    }
    if (ts.isJsxText(node)) {
      // Visible text, not class names.
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const parsed = { source, imports, readsProcessEnv, calls, strings };
  cache.set(file, parsed);
  return parsed;
}

const under = (file: string, ...prefixes: string[]) =>
  prefixes.some((p) => file.startsWith(p));

function offenders(
  list: string[],
  check: (file: string, p: Parsed) => string | false | undefined,
): string[] {
  const out: string[] = [];
  for (const f of list) {
    const r = check(f, parse(f));
    if (r) out.push(`${f}: ${r}`);
  }
  return out;
}

const isNext = (m: string) => m === "next" || m.startsWith("next/");
const isNextIntl = (m: string) =>
  m === "next-intl" || m.startsWith("next-intl/");
/** Request-time Next APIs that belong to the Next layer only. */
const NEXT_LAYER_ONLY = new Set([
  "next/headers",
  "next/cache",
  "next/server",
  "next/root-params",
  "better-auth/next-js",
]);

describe("architecture (spec §2.2)", () => {
  it("finds the source tree", () => {
    expect(SRC.length).toBeGreaterThan(50);
    expect(SCRIPTS.length).toBeGreaterThan(5);
  });

  it("every src/server file except auth/options.ts starts with import 'server-only'", () => {
    const bad = offenders(
      SRC.filter(
        (f) =>
          f.startsWith("src/server/") && f !== "src/server/auth/options.ts",
      ),
      (_f, p) => {
        const first = p.source.statements[0];
        const ok =
          first !== undefined &&
          ts.isImportDeclaration(first) &&
          ts.isStringLiteral(first.moduleSpecifier) &&
          first.moduleSpecifier.text === "server-only" &&
          first.importClause === undefined;
        return ok ? false : 'first statement is not `import "server-only"`';
      },
    );
    expect(bad).toEqual([]);
  });

  it("auth/options.ts stays pure (no server-only, next/*, process.env)", () => {
    const p = parse("src/server/auth/options.ts");
    expect(p.imports.filter((m) => m === "server-only" || isNext(m))).toEqual(
      [],
    );
    expect(p.readsProcessEnv).toBe(false);
  });

  it("domain services, lib, emails and content never import next/* or next-intl", () => {
    const bad = offenders(
      SRC.filter(
        (f) =>
          under(f, "src/server/", "src/lib/", "src/emails/", "src/content/") &&
          !f.startsWith("src/server/next/"),
      ),
      (_f, p) => {
        const hits = p.imports.filter(
          (m) => isNext(m) || isNextIntl(m) || m === "better-auth/next-js",
        );
        return hits.length > 0 && hits.join(", ");
      },
    );
    expect(bad).toEqual([]);
  });

  it("request-time Next APIs are used only in the Next layer", () => {
    const allowed = (f: string) =>
      under(f, "src/app/", "src/server/next/", "src/i18n/") ||
      f === "src/proxy.ts" ||
      f === "src/instrumentation.ts";
    const bad = offenders(
      SRC.filter((f) => !allowed(f)),
      (_f, p) => {
        const hits = p.imports.filter((m) => NEXT_LAYER_ONLY.has(m));
        return hits.length > 0 && hits.join(", ");
      },
    );
    expect(bad).toEqual([]);
  });

  it("UI code (components, emails, content, lib) never imports @/server", () => {
    const bad = offenders(
      SRC.filter((f) =>
        under(f, "src/components/", "src/emails/", "src/content/", "src/lib/"),
      ),
      (_f, p) => {
        const hits = p.imports.filter(
          (m) =>
            m === "@/server" ||
            m.startsWith("@/server/") ||
            (/(^|\/)server\//.test(m) && m.startsWith(".")),
        );
        return hits.length > 0 && hits.join(", ");
      },
    );
    expect(bad).toEqual([]);
  });

  it("process.env is read only in src/server/env.ts and src/lib/public-env.ts", () => {
    const allowed = new Set(["src/server/env.ts", "src/lib/public-env.ts"]);
    const bad = offenders(
      SRC.filter((f) => !allowed.has(f)),
      (_f, p) => p.readsProcessEnv && "reads process.env",
    );
    expect(bad).toEqual([]);
  });

  it("uses logical Tailwind classes only (no ml-/mr-/pl-/pr-/left-/right-/start-/end-/text-left/text-right)", () => {
    const PHYSICAL =
      /^-?(?:ml|mr|pl|pr|left|right|start|end)-\S+$|^text-(?:left|right)$/;
    const bad = offenders(
      SRC.filter((f) => f.endsWith(".tsx") || under(f, "src/components/")),
      (_f, p) => {
        const hits = new Set<string>();
        for (const s of p.strings) {
          for (const raw of s.split(/\s+/)) {
            const token = raw
              .replace(/^(?:[^:\s[\]]+:)+/, "")
              .replace(/^!/, "");
            if (PHYSICAL.test(token)) hits.add(raw);
          }
        }
        return hits.size > 0 && [...hits].join(" ");
      },
    );
    expect(bad).toEqual([]);
  });

  it("every export of an admin actions.ts is wrapped by adminAction", () => {
    const actionFiles = SRC.filter(
      (f) => /\/admin\//.test(f) && /\/actions\.tsx?$/.test(f),
    );
    const bad = offenders(actionFiles, (_f, p) => {
      const problems: string[] = [];
      for (const st of p.source.statements) {
        const exported = ts
          .getModifiers(st as ts.HasModifiers)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (!exported) continue;
        if (ts.isFunctionDeclaration(st)) {
          problems.push(`function ${st.name?.text ?? "default"}`);
        } else if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            const init = d.initializer;
            const wrapped =
              init !== undefined &&
              ts.isCallExpression(init) &&
              ts.isIdentifier(init.expression) &&
              init.expression.text === "adminAction";
            if (!wrapped) problems.push(d.name.getText(p.source));
          }
        }
      }
      for (const st of p.source.statements) {
        if (ts.isExportAssignment(st)) problems.push("export default");
      }
      return problems.length > 0 && `not adminAction: ${problems.join(", ")}`;
    });
    expect(bad).toEqual([]);
  });

  it("every admin page.tsx / route.ts calls requireAdmin (or the adminRoute wrapper)", () => {
    const guarded = SRC.filter(
      (f) =>
        /\/(page\.tsx|route\.ts)$/.test(f) &&
        (/^src\/app\/\[locale\]\/admin\//.test(f) ||
          /\/print\/admin\//.test(f) ||
          f.startsWith("src/app/api/admin/")) &&
        // The sign-in pages run before a session exists (spec §6.10).
        !f.startsWith("src/app/[locale]/admin/login/"),
    );
    expect(guarded.length).toBeGreaterThan(0);
    const bad = offenders(guarded, (_f, p) => {
      const ok =
        p.calls.has("requireAdmin") ||
        p.calls.has("requireAdminForRoute") ||
        p.calls.has("adminRoute");
      return !ok && "no requireAdmin call";
    });
    expect(bad).toEqual([]);
  });

  it("scripts never import jobs, the outbox processor, rendering code or the Next layer", () => {
    const FORBIDDEN =
      /(^@\/server\/|(^|\/)src\/server\/)(jobs(\/|$)|outbox\/process(\.ts)?$|email\/render(\.ts)?$|documents\/pdf(\/|$)|next(\/|$))/;
    const RENDERERS = new Set([
      "react-email",
      "@react-email/render",
      "@react-pdf/renderer",
      "react-dom/server",
    ]);
    const bad = offenders(SCRIPTS, (_f, p) => {
      const hits = p.imports.filter(
        (m) => FORBIDDEN.test(m) || RENDERERS.has(m),
      );
      return hits.length > 0 && hits.join(", ");
    });
    expect(bad).toEqual([]);
  });

  it("the TLS-verification kill switch (NODE_TLS_…) appears nowhere in code", () => {
    const needle = ["NODE", "TLS", "REJECT", "UNAUTHORIZED"].join("_");
    const code = [
      ...SRC,
      ...SCRIPTS,
      ...files("tests"),
      "next.config.ts",
      "vitest.config.ts",
      "playwright.config.ts",
      "drizzle.config.ts",
    ];
    const bad = code.filter((f) => {
      try {
        return readFileSync(join(ROOT, f), "utf8").includes(needle);
      } catch {
        return false;
      }
    });
    expect(bad).toEqual([]);
  });
});
