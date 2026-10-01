// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(workspaceRoot, "packages");
const productionRoots = [sourceRoot, resolve(workspaceRoot, "scripts")];
const productionSources = Promise.all(productionRoots.map(sourceFiles)).then((groups) =>
  Promise.all(groups.flat().map(async (path) => ({ path, source: await readFile(path, "utf8") }))),
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
  "scripts/artifact-security.ts",
  "scripts/fresh-clone.ts",
  "scripts/generate-codex-bindings.ts",
  "scripts/package-build.ts",
  "scripts/package-release.ts",
  "scripts/package-verification.ts",
  "scripts/process.ts",
  "scripts/release-version.ts",
  "scripts/repository-proof.ts",
  "scripts/validate.ts",
  "scripts/version.ts",
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
  "packages/codex/scripts/verify-generated-artifact.ts",
  "scripts/artifact-security.ts",
  "scripts/fresh-clone.ts",
  "scripts/generate-codex-bindings.ts",
  "scripts/package-build.ts",
  "scripts/package-release.ts",
  "scripts/package-verification.ts",
  "scripts/process.ts",
  "scripts/release-version.ts",
  "scripts/repository-proof.ts",
  "scripts/validate.ts",
  "scripts/version.ts",
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
      const executable = withoutStrings(source);
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (
        /export\s+(?:async\s+)?function[\s\S]*?Promise|export\s+interface[\s\S]*?Promise/u.test(
          executable,
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

  test("keeps Promise orchestration and try/catch out of project logic", async () => {
    const files = await productionSources;
    const violations: string[] = [];
    for (const { path, source: rawSource } of files) {
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      for (const violation of effectArchitectureViolations(rawSource)) {
        violations.push(`${relativePath}: ${violation}`);
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

  test("rejects handwritten Promise orchestration and try/catch but accepts Effect APIs", () => {
    expect(effectArchitectureViolations("await Promise.all([first(), second()]);")).toContain(
      "handwritten Promise orchestration",
    );
    expect(effectArchitectureViolations("try { run(); } catch (error) { fail(error); }")).toContain(
      "try/catch",
    );
    expect(
      effectArchitectureViolations(
        "Effect.gen(function* () { yield* Effect.all([first, second]); }).pipe(Effect.catch(handler));",
      ),
    ).toEqual([]);
    expect(
      effectArchitectureViolations('const example = "try { Promise.all([]) } catch (e) {}";'),
    ).toEqual([]);
  });

  test("rejects async workflows and nested Effect runners while allowing the CLI runner", () => {
    expect(effectArchitectureViolations("async function workflow() { await load(); }")).toContain(
      "async Promise workflow",
    );
    expect(
      effectArchitectureViolations(
        "Effect.gen(function* () { yield* load(); return yield* Effect.runPromise(other()); });",
      ),
    ).toContain("Effect runner inside an Effect workflow");
    expect(
      effectArchitectureViolations("if (import.meta.main) { await Effect.runPromise(program); }"),
    ).toEqual([]);
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
    if (entry.isDirectory() && entry.name !== "dist") result.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !portablePath.includes("/generated/")
    )
      result.push(path);
  }
  return result;
}

function effectArchitectureViolations(source: string): readonly string[] {
  const executable = withoutStrings(withoutComments(source));
  const workflowCode = withoutMainEntrypoint(executable);
  const violations: string[] = [];
  if (
    /\bnew\s+Promise\b|\bPromise\s*\.\s*(?:all|allSettled|any|race)\b|(?<!Effect)\.(?:then|catch|finally)\s*\(/u.test(
      executable,
    )
  ) {
    violations.push("handwritten Promise orchestration");
  }
  if (/\btry\s*\{|(?<!Effect\.)\bcatch\s*\(/u.test(executable)) {
    violations.push("try/catch");
  }
  if (/\basync\b|\bawait\b/u.test(workflowCode)) {
    violations.push("async Promise workflow");
  }
  const generatorStarts = [...executable.matchAll(/Effect\.gen\s*\(\s*function\*/gu)];
  const runnerPositions = [...executable.matchAll(/Effect\.runPromise(?:Exit)?\s*\(/gu)].map(
    (match) => match.index ?? -1,
  );
  if (
    generatorStarts.some((match) => {
      const bodyStart = executable.indexOf("{", (match.index ?? 0) + match[0].length);
      if (bodyStart < 0) return false;
      const bodyEnd = matchingBrace(executable, bodyStart);
      return runnerPositions.some((position) => position > bodyStart && position < bodyEnd);
    })
  ) {
    violations.push("Effect runner inside an Effect workflow");
  }
  return violations;
}

function withoutMainEntrypoint(source: string): string {
  const marker = /if\s*\(\s*import\.meta\.main\s*\)\s*\{/gu;
  const characters = source.split("");
  for (const match of source.matchAll(marker)) {
    const bodyStart = (match.index ?? 0) + match[0].length - 1;
    const bodyEnd = matchingBrace(source, bodyStart);
    for (let index = match.index ?? 0; index <= bodyEnd; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

function matchingBrace(source: string, openingIndex: number): number {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

/** Blank literal contents so embedded fixture and shell text cannot masquerade as code. */
function withoutStrings(source: string): string {
  const characters = source.split("");
  const contexts: Array<{ kind: "code" | "template"; interpolation?: boolean; braces?: number }> = [
    { kind: "code" },
  ];
  for (let index = 0; index < source.length; index += 1) {
    const context = contexts.at(-1);
    if (!context) break;
    const character = source[index];
    const next = source[index + 1];
    if (context.kind === "template") {
      if (character === "\\") {
        characters[index] = " ";
        index += 1;
        if (index < characters.length) characters[index] = " ";
      } else if (character === "`") {
        contexts.pop();
      } else if (character === "$" && next === "{") {
        contexts.push({ kind: "code", interpolation: true, braces: 1 });
        index += 1;
      } else if (character !== "\n" && character !== "\r") {
        characters[index] = " ";
      }
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      characters[index] = " ";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          characters[index] = " ";
          index += 1;
          if (index < source.length && source[index] !== "\n" && source[index] !== "\r")
            characters[index] = " ";
        } else if (source[index] === quote) {
          characters[index] = " ";
          break;
        } else {
          if (source[index] !== "\n" && source[index] !== "\r") characters[index] = " ";
        }
        index += 1;
      }
      continue;
    }
    if (character === "`") {
      contexts.push({ kind: "template" });
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
  return characters.join("");
}
