// SPDX-License-Identifier: Apache-2.0

import { WorkflowRuntimeError } from "./protocol.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

const require = createRequire(import.meta.url);

const FORBIDDEN_WORDS = new Set([
  "enum",
  "namespace",
  "module",
  "require",
  "eval",
  "Function",
  "WebAssembly",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "accessor",
  "using",
]);
const FORBIDDEN_KEYWORDS = new Set([
  "enum",
  "namespace",
  "module",
  "import",
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "accessor",
  "using",
]);

const NATIVE_FORBIDDEN_IDENTIFIERS = new Set([
  "require",
  "process",
  "Bun",
  "Deno",
  "fs",
  "fetch",
  "WebSocket",
  "child_process",
  "eval",
  "Function",
  "WebAssembly",
  "globalThis",
  "XMLHttpRequest",
  "SharedArrayBuffer",
  "Atomics",
  "async",
  "await",
]);

const NATIVE_WORKFLOW_IMPORTS = new Set(["workflow", "createCodec"]);
const NATIVE_SCHEMA_IMPORTS = new Set([
  "String",
  "Number",
  "Boolean",
  "Unknown",
  "Literal",
  "Array",
  "Struct",
]);

type SourceReplacement = Readonly<{
  readonly start: number;
  readonly end: number;
  readonly text: string;
}>;

export function transformWorkflowSource(source: string, maxSourceBytes: number): string {
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > maxSourceBytes) {
    throw sourceError("The workflow source is too large.");
  }

  const scanner = createScanner(true, LanguageVariant.Standard, source, 0, source.length);
  const replacements: SourceReplacement[] = [];
  let braceDepth = 0;
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    const text = scanner.getTokenText();
    const start = scanner.getTokenStart();
    if (
      text === "@" ||
      FORBIDDEN_KEYWORDS.has(text) ||
      (scanner.isIdentifier() && FORBIDDEN_WORDS.has(text))
    ) {
      throw sourceError(`The workflow uses forbidden syntax: ${text}.`);
    }
    if (text === "import") {
      throw sourceError("Workflow imports are disabled.");
    }
    if (text === "export") {
      if (braceDepth !== 0) {
        throw sourceError("Nested exports are disabled.");
      }
      const exportStart = start;
      const nextKind = scanner.scan();
      if (nextKind === SyntaxKind.EndOfFile || scanner.getTokenText() !== "default") {
        throw sourceError("Only a default workflow result is supported.");
      }
      replacements.push({ start: exportStart, end: scanner.getTokenEnd(), text: "return " });
      token = scanner.scan();
      continue;
    }
    if (text === "{") {
      braceDepth += 1;
    } else if (text === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
    token = scanner.scan();
  }

  const rewritten = applyReplacements(source, replacements);
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
    return transpiler.transformSync(
      `globalThis.__workflow = async (args, runtime, agent) => {\n${rewritten}\n};`,
    );
  } catch {
    throw sourceError("The workflow TypeScript source is invalid.");
  }
}

/**
 * Transforms a native TypeScript workflow as text. No source is loaded as a
 * module; the returned JavaScript is data for the bounded QuickJS evaluator.
 */
export function transformNativeWorkflowSource(
  source: string,
  maxSourceBytes: number,
  maxTransformedBytes: number,
): string {
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > maxSourceBytes) {
    throw sourceError("The native workflow source is too large.");
  }
  const transformed = compileNativeWorkflowSource(source);
  if (new TextEncoder().encode(transformed).byteLength > maxTransformedBytes) {
    throw sourceError("The transformed native workflow is too large.");
  }
  return transformed;
}

const WORKFLOW_DECLARATIONS = `
type WorkflowJsonPrimitive = string | number | boolean | null;
type WorkflowJsonValue = WorkflowJsonPrimitive | readonly WorkflowJsonValue[] | { readonly [key: string]: WorkflowJsonValue };
interface WorkflowValueCodec<T extends WorkflowJsonValue = WorkflowJsonValue> { readonly name: string; readonly decode: (value: unknown) => T; }
interface WorkflowAssignment<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> { readonly payload?: WorkflowJsonValue; readonly input: WorkflowValueCodec<I>; readonly output: WorkflowValueCodec<O>; readonly metadata?: Record<string, WorkflowJsonValue>; readonly route?: string; }
interface WorkflowStepDefinition<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> { readonly id: string; readonly assignment: WorkflowAssignment<I, O>; }
interface WorkflowValue<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> { readonly input: I; readonly output: O; }
interface WorkflowWait<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> { readonly input: I; readonly result: O; }
type WorkflowQueueStageOutput<Current extends WorkflowJsonValue, Stage> = Stage extends WorkflowValue<Current, infer Output> ? Output : Stage extends WorkflowWait<Current, infer Output> ? Output : Stage extends (input: Current) => WorkflowValue<Current, infer Output> ? Output : Stage extends (input: Current) => WorkflowWait<Current, infer Output> ? Output : never;
type WorkflowQueueStageChain<Current extends WorkflowJsonValue, Stages extends readonly unknown[]> = Stages extends readonly [infer Stage, ...infer Rest] ? [WorkflowQueueStageOutput<Current, Stage>] extends [never] ? never : readonly [Stage, ...WorkflowQueueStageChain<WorkflowQueueStageOutput<Current, Stage>, Rest>] : readonly [];
type WorkflowQueueOutput<Current extends WorkflowJsonValue, Stages extends readonly unknown[]> = Stages extends readonly [infer Stage, ...infer Rest] ? WorkflowQueueOutput<WorkflowQueueStageOutput<Current, Stage>, Rest> : Current;
interface WorkflowDsl {
  readonly step: <I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue>(definition: WorkflowStepDefinition<I, O>) => WorkflowValue<I, O>;
  readonly queue: <I extends WorkflowJsonValue, O extends WorkflowJsonValue, const Stages extends readonly unknown[]>(first: WorkflowValue<I, O>, ...stages: Stages & WorkflowQueueStageChain<O, Stages>) => WorkflowValue<I, WorkflowQueueOutput<O, Stages>>;
  readonly start: <I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue>(workflow: WorkflowValue<I, O>) => WorkflowValue<I, O>;
  readonly wait: {
    <I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue>(workflow: WorkflowValue<I, O> | WorkflowWait<I, O>): WorkflowWait<I, O>;
    <Named extends Record<string, WorkflowValue<WorkflowJsonValue, WorkflowJsonValue> | WorkflowWait<WorkflowJsonValue, WorkflowJsonValue>>>(values: Named): WorkflowWait<WorkflowJsonValue, WorkflowJsonValue>;
  };
}
interface WorkflowPortableSchema<T extends WorkflowJsonValue = WorkflowJsonValue> { readonly __holycodexSchema: WorkflowJsonValue; readonly _type?: T; }
declare module "@holycodex/workflow" {
  export type JsonValue = WorkflowJsonValue;
  export type ValueCodec<T extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowValueCodec<T>;
  export type Assignment<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowAssignment<I, O>;
  export type StepDefinition<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowStepDefinition<I, O>;
  export type Workflow<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowValue<I, O>;
  export type Wait<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowWait<I, O>;
  export const workflow: WorkflowDsl;
  export function createCodec<T extends WorkflowJsonValue = WorkflowJsonValue>(name: string, decoder: ((value: unknown) => T) | WorkflowPortableSchema<T>): ValueCodec<T>;
}
declare module "@holycodex/workflow-runtime" {
  export type ValueCodec<T extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowValueCodec<T>;
  export type Assignment<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowAssignment<I, O>;
  export type StepDefinition<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowStepDefinition<I, O>;
  export type Workflow<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowValue<I, O>;
  export type Wait<I extends WorkflowJsonValue = WorkflowJsonValue, O extends WorkflowJsonValue = WorkflowJsonValue> = WorkflowWait<I, O>;
  export const workflow: WorkflowDsl;
  export function createCodec<T extends WorkflowJsonValue = WorkflowJsonValue>(name: string, decoder: ((value: unknown) => T) | WorkflowPortableSchema<T>): ValueCodec<T>;
}
declare module "effect/Schema" {
  export interface Schema<T extends WorkflowJsonValue = WorkflowJsonValue> extends WorkflowPortableSchema<T> {}
  export const String: Schema<string>;
  export const Number: Schema<number>;
  export const Boolean: Schema<boolean>;
  export const Unknown: Schema<WorkflowJsonValue>;
  export function Literal<T extends string | number | boolean | null>(value: T): Schema<T>;
  export function Array<T>(element: Schema<T>): Schema<readonly T[]>;
  export function Struct<const Fields extends Record<string, Schema>>(fields: Fields): Schema<{ readonly [K in keyof Fields]: Fields[K] extends Schema<infer T> ? T : never }>;
}
`;

function compileNativeWorkflowSource(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "holycodex-workflow-"));
  const sourceFile = join(root, "workflow.ts");
  const declarationFile = join(root, "workflow-modules.d.ts");
  const configFile = join(root, "tsconfig.json");
  try {
    writeFileSync(sourceFile, source);
    writeFileSync(declarationFile, WORKFLOW_DECLARATIONS);
    writeFileSync(
      configFile,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
        },
        files: [sourceFile, declarationFile],
      }),
    );
    const compiler = resolveTypeScriptCompiler();
    const check = spawnSync(compiler, ["--project", configFile, "--pretty", "false"], {
      encoding: "utf8",
    });
    if (check.status !== 0) {
      throw sourceError(
        `The native workflow TypeScript source is invalid:\n${(check.stdout || check.stderr).trim()}`,
      );
    }
    const rewritten = rewriteNativeSource(source);
    const outputFile = join(root, "workflow.emit.js");
    const emitConfig = join(root, "emit-tsconfig.json");
    writeFileSync(
      join(root, "workflow.emit.ts"),
      `let __hcWorkflowResult;\n${rewritten}\nreturn __hcWorkflowResult;`,
    );
    writeFileSync(
      emitConfig,
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", noCheck: true, outDir: root },
        files: [join(root, "workflow.emit.ts")],
      }),
    );
    const emit = spawnSync(compiler, ["--project", emitConfig, "--pretty", "false"], {
      encoding: "utf8",
    });
    if (emit.status !== 0)
      throw sourceError("The native workflow TypeScript source could not be emitted.");
    const emitted = readFileSync(outputFile, "utf8");
    return `(() => {\n${emitted}\n})()`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function resolveTypeScriptCompiler(): string {
  const platform =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const packageName = `@typescript/typescript-${platform}-${architecture}`;
  try {
    const packageRoot = dirname(require.resolve("typescript/package.json"));
    const executable = process.platform === "win32" ? "tsc.exe" : "tsc";
    const direct = join(packageRoot, "lib", executable);
    try {
      readFileSync(direct);
      return direct;
    } catch {
      const bunRoot = join(packageRoot, "..", "..", "..");
      const platformDir = readdirSync(bunRoot).find((entry) =>
        entry.startsWith(`${packageName.replace("/", "+")}@`),
      );
      if (!platformDir) throw new Error("platform compiler package is missing");
      return join(bunRoot, platformDir, "node_modules", packageName, "lib", executable);
    }
  } catch {
    throw sourceError("The TypeScript compiler is unavailable for native workflows.");
  }
}

function rewriteNativeSource(source: string): string {
  const tokens = scan(source);
  const replacements: SourceReplacement[] = [];
  let braceDepth = 0;
  let exports = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "import") {
      if (braceDepth !== 0) throw sourceError("Nested native workflow imports are disabled.");
      const end = findStatementEnd(tokens, index);
      replacements.push({
        start: token.start,
        end,
        text: nativeImportReplacement(source.slice(token.start, end)),
      });
      index = tokenIndexAtOrBefore(tokens, end) - 1;
    } else if (token.text === "export") {
      if (braceDepth !== 0) throw sourceError("Nested exports are disabled.");
      const next = tokens[index + 1];
      if (next?.text !== "default")
        throw sourceError("Only a default native workflow export is supported.");
      exports += 1;
      replacements.push({ start: token.start, end: next.end, text: "__hcWorkflowResult = " });
      index += 1;
    } else if (
      token.text === "await" ||
      (token.isIdentifier && NATIVE_FORBIDDEN_IDENTIFIERS.has(token.text))
    ) {
      throw sourceError(`The native workflow uses forbidden syntax: ${token.text}.`);
    }
    if (token.text === "{") braceDepth += 1;
    if (token.text === "}") braceDepth = Math.max(0, braceDepth - 1);
  }
  if (exports !== 1)
    throw sourceError("The native workflow must export exactly one workflow.wait(...) value.");
  return applyReplacements(source, replacements);
}

function nativeImportReplacement(statement: string): string {
  const match =
    /^import\s+(type\s+)?(\{[\s\S]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']\s*;?$/u.exec(
      statement.trim(),
    );
  if (!match)
    throw sourceError("Native workflows may use only named imports from the approved modules.");
  if (match[1]) return "";
  const moduleName = match[3];
  if (
    moduleName !== "@holycodex/workflow" &&
    moduleName !== "@holycodex/workflow-runtime" &&
    moduleName !== "effect/Schema"
  )
    throw sourceError(
      "Native workflow imports are restricted to @holycodex/workflow and effect/Schema.",
    );
  const bindings = match[2] ?? "";
  if (bindings.startsWith("*")) {
    if (moduleName !== "effect/Schema")
      throw sourceError("Workflow imports must be named imports.");
    const local = bindings.slice(bindings.indexOf("as") + 3).trim();
    return local === "Schema" ? "" : `const ${local} = Schema;`;
  }
  return bindings
    .slice(1, -1)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(/\s+as\s+/u).map((part) => part.trim());
      const imported = parts[0] ?? "";
      const local = parts[1] ?? imported;
      if (imported.startsWith("type ")) return "";
      const name = imported.replace(/^type\s+/u, "");
      const allowed =
        moduleName === "effect/Schema" ? NATIVE_SCHEMA_IMPORTS : NATIVE_WORKFLOW_IMPORTS;
      if (!allowed.has(name))
        throw sourceError(`The native workflow import ${name} is not approved.`);
      if (local === name && moduleName !== "effect/Schema") return "";
      return `const ${local} = ${moduleName === "effect/Schema" ? `Schema.${name}` : name};`;
    })
    .filter(Boolean)
    .join("\n");
}

type ScannedToken = Readonly<{
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly isIdentifier: boolean;
}>;

function scan(source: string): readonly ScannedToken[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source, 0, source.length);
  const tokens: ScannedToken[] = [];
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    tokens.push({
      text: scanner.getTokenText(),
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      isIdentifier: scanner.isIdentifier(),
    });
    token = scanner.scan();
  }
  return tokens;
}

function findStatementEnd(tokens: readonly ScannedToken[], startIndex: number): number {
  let sawFrom = false;
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "from") {
      sawFrom = true;
      continue;
    }
    if (sawFrom && /^['"]/u.test(token.text)) {
      const semicolon = tokens[index + 1];
      return semicolon?.text === ";" ? semicolon.end : token.end;
    }
  }
  throw sourceError("The native workflow import is incomplete.");
}

function tokenIndexAtOrBefore(tokens: readonly ScannedToken[], position: number): number {
  let index = 0;
  while (index < tokens.length && (tokens[index]?.start ?? 0) < position) index += 1;
  return index;
}

function applyReplacements(source: string, replacements: readonly SourceReplacement[]): string {
  let result = source;
  const ordered = [...replacements].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const replacement = ordered[index];
    if (!replacement) {
      continue;
    }
    result = `${result.slice(0, replacement.start)}${replacement.text}${result.slice(replacement.end)}`;
  }
  return result;
}

function sourceError(message: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError("source_rejected", message);
}
