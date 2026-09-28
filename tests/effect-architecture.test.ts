// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(workspaceRoot, "packages");
const productionSources = sourceFiles(sourceRoot).then((paths) =>
  Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, "utf8") }))),
);

// These are the existing Promise-facing seams. New domain APIs must expose an
// Effect and add a deliberate leaf adapter instead of expanding this list.
const promiseAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/commands.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/installer-wizard.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/native-agents.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/tooling.ts",
  "packages/cli/src/types.ts",
  "packages/codex/src/client.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/managed-config.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/runtime-config.ts",
  "packages/codex/src/transport.ts",
  "packages/agent/src/index.ts",
  "packages/core/src/canonical.ts",
  "packages/core/src/work-state.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/planning.ts",
  "packages/plugin/src/schemas.ts",
  "packages/plugin/src/source.ts",
  "packages/plugin/src/verification.ts",
]);

const ioAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/lock.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/installer-wizard.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/migration.ts",
  "packages/cli/src/native-agents.ts",
  "packages/cli/src/official-manager.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/tooling.ts",
  "packages/cli/src/index.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/transport.ts",
  "packages/agent/src/index.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/source.ts",
  "packages/core/src/work-state.ts",
]);

describe("Effect architecture boundaries", () => {
  test("keeps forbidden imports and unsafe any out of production source", async () => {
    const files = await productionSources;
    const violations: string[] = [];
    for (const { path, source } of files) {
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (/effect\/internal/u.test(source)) violations.push(`${relativePath}: effect/internal`);
      if (/(?:\bas\s+any\b|:\s*any\b|<any>|[|&]\s*any\b)/u.test(source)) {
        violations.push(`${relativePath}: any`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("requires Promise APIs and direct platform I/O to stay in explicit adapters", async () => {
    const files = await productionSources;
    const violations: string[] = [];
    for (const { path, source: rawSource } of files) {
      const source = withoutComments(rawSource);
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (
        /export\s+(?:async\s+)?function[\s\S]*?Promise|export\s+interface[\s\S]*?Promise/u.test(
          source,
        )
      ) {
        if (!promiseAdapterAllowlist.has(relativePath))
          violations.push(`${relativePath}: Promise API`);
      }
      if (
        /from\s+["']node:(?:fs|fs\/promises|child_process|process|os|net|http|https)["']|\bprocess\./u.test(
          source,
        ) &&
        !ioAdapterAllowlist.has(relativePath)
      ) {
        violations.push(`${relativePath}: direct platform I/O`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("ignores comments without changing string and template literals", () => {
    const source = [
      '/** process.execPath and from "node:fs" are documentation. */',
      'const text = "/* process.cwd() */";',
      "const template = `// process.env\\n${process.cwd()}`;",
      "/* from 'node:process' */",
    ].join("\n");

    const executable = withoutComments(source);

    expect(executable).not.toContain("process.execPath");
    expect(executable).not.toContain('from "node:fs"');
    expect(executable).toContain('"/* process.cwd() */"');
    expect(executable).toContain("// process.env\\n");
    expect(/\bprocess\./u.test(executable)).toBe(true);
  });
});

/** Remove TypeScript comments while retaining quoted and template literal text. */
function withoutComments(source: string): string {
  const contexts: Array<{ kind: "code" | "template"; interpolation?: boolean; braces?: number }> = [
    { kind: "code" },
  ];
  const parts: string[] = [];
  let copiedThrough = 0;

  for (let index = 0; index < source.length; index += 1) {
    const context = contexts.at(-1);
    if (!context) break;
    const character = source[index];
    const next = source[index + 1];

    if (context.kind === "template") {
      if (character === "\\") index += 1;
      else if (character === "`") contexts.pop();
      else if (character === "$" && next === "{") {
        contexts.push({ kind: "code", interpolation: true, braces: 1 });
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) break;
        else index += 1;
      }
      continue;
    }
    if (character === "`") {
      contexts.push({ kind: "template" });
      continue;
    }
    if (character === "/" && (next === "/" || next === "*")) {
      const lineComment = next === "/";
      const start = index;
      index += 2;
      if (lineComment) {
        while (index < source.length && source[index] !== "\n") index += 1;
      } else {
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
          index += 1;
        index = Math.min(index + 2, source.length);
      }
      parts.push(
        source.slice(copiedThrough, start),
        source.slice(start, index).replace(/[^\r\n]/gu, " "),
      );
      copiedThrough = index;
      index -= 1;
      continue;
    }
    if (context.interpolation) {
      if (character === "{") context.braces = (context.braces ?? 0) + 1;
      else if (character === "}") {
        context.braces = (context.braces ?? 1) - 1;
        if (context.braces === 0) contexts.pop();
      }
    }
  }

  return parts.join("") + source.slice(copiedThrough);
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const portablePath = path.replaceAll("\\", "/");
    if (entry.isDirectory() && entry.name !== "scripts" && entry.name !== "dist")
      result.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !portablePath.includes("/generated/")
    )
      result.push(path);
  }
  return result;
}
