// SPDX-License-Identifier: Apache-2.0

import { WorkflowRuntimeError } from "./protocol.ts";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

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

const NATIVE_RUNTIME_IMPORTS = new Set(["workflow", "createCodec"]);

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
      const next = nextToken(scanner);
      if (next.text !== "default") {
        throw sourceError("Only a default workflow result is supported.");
      }
      replacements.push({ start: exportStart, end: next.end, text: "return " });
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
  const tokens = scan(source);
  const replacements: SourceReplacement[] = [];
  let braceDepth = 0;
  let defaultExports = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "{") braceDepth += 1;
    if (token.text === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (token.text === "import") {
      if (tokens[index + 1]?.text === "(") {
        throw sourceError("Dynamic workflow imports are disabled.");
      }
      if (braceDepth !== 0) {
        throw sourceError("Nested workflow imports are disabled.");
      }
      const end = findStatementEnd(tokens, index);
      const statement = source.slice(token.start, end);
      replacements.push({ start: token.start, end, text: nativeImportReplacement(statement) });
      index = tokenIndexAtOrBefore(tokens, end) - 1;
      continue;
    }
    if (token.text === "export") {
      if (braceDepth !== 0 || tokens[index + 1]?.text !== "default") {
        throw sourceError("Only one default native workflow export is supported.");
      }
      defaultExports += 1;
      const next = tokens[index + 1];
      if (!next) throw sourceError("The native workflow default export is incomplete.");
      replacements.push({ start: token.start, end: next.end, text: "return " });
      index += 1;
      continue;
    }
    if (token.isIdentifier && NATIVE_FORBIDDEN_IDENTIFIERS.has(token.text)) {
      throw sourceError(`The native workflow uses forbidden syntax: ${token.text}.`);
    }
  }
  if (defaultExports !== 1) {
    throw sourceError(
      "The native workflow must export exactly one default workflow.wait(...) value.",
    );
  }
  replacements.push(...findTypeScriptRemovals(tokens, source, replacements));
  const rewritten = applyReplacements(source, deduplicateReplacements(replacements));
  const transformed = `(() => {\n${rewritten}\n})()`;
  if (new TextEncoder().encode(transformed).byteLength > maxTransformedBytes) {
    throw sourceError("The transformed native workflow is too large.");
  }
  return transformed;
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

function nativeImportReplacement(statement: string): string {
  const match = /^import\s+(type\s+)?\{([\s\S]*)\}\s+from\s+["']([^"']+)["']\s*;?$/u.exec(
    statement.trim(),
  );
  if (!match) {
    throw sourceError("Native workflows may use only explicit named imports from the runtime DSL.");
  }
  const typeOnly = match[1] !== undefined;
  const moduleName = match[3];
  if (moduleName !== "@holycodex/workflow-runtime") {
    throw sourceError("Native workflow imports must use @holycodex/workflow-runtime.");
  }
  const names = (match[2] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const name of names) {
    if (name.startsWith("type ")) continue;
    const [imported, local] = name.split(/\s+as\s+/u).map((value) => value.trim());
    if (typeOnly) continue;
    if (!imported || !NATIVE_RUNTIME_IMPORTS.has(imported)) {
      throw sourceError(`The native workflow import ${imported ?? ""} is not approved.`);
    }
    if (local && local !== imported) {
      throw sourceError("Native workflow import aliases are not supported.");
    }
  }
  return "";
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

function findTypeScriptRemovals(
  tokens: readonly ScannedToken[],
  source: string,
  existingReplacements: readonly SourceReplacement[],
): readonly SourceReplacement[] {
  const removals: SourceReplacement[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (
      existingReplacements.some(
        (replacement) => replacement.start <= token.start && token.end <= replacement.end,
      )
    ) {
      continue;
    }
    if (token.text === "type" || token.text === "interface") {
      const previous = tokens[index - 1]?.text;
      if (previous === "import") continue;
      const end = findTypeDeclarationEnd(tokens, index);
      removals.push({ start: token.start, end, text: "" });
      index = tokenIndexAtOrBefore(tokens, end) - 1;
      continue;
    }
    if (token.text === "as" || token.text === "satisfies") {
      const end = findTypeExpressionEnd(tokens, index);
      removals.push({ start: token.start, end, text: "" });
      index = tokenIndexAtOrBefore(tokens, end) - 1;
      continue;
    }
    if (token.text === "<" && isTypeArgumentList(tokens, index)) {
      const end = matchingTokenEnd(tokens, index, "<", ">");
      if (end !== undefined) {
        removals.push({ start: token.start, end, text: "" });
        index = tokenIndexAtOrBefore(tokens, end) - 1;
      }
      continue;
    }
    if (token.text === ":" && isTypeAnnotation(tokens, index)) {
      const end = findTypeExpressionEnd(tokens, index);
      removals.push({ start: token.start, end, text: "" });
      index = tokenIndexAtOrBefore(tokens, end) - 1;
      continue;
    }
    if (
      token.text === "?" &&
      tokens[index + 1]?.text === ":" &&
      isTypeAnnotation(tokens, index + 1)
    ) {
      removals.push({ start: token.start, end: token.end, text: "" });
    }
    if (token.text === "!" && isNonNullAssertion(tokens, index)) {
      removals.push({ start: token.start, end: token.end, text: "" });
    }
  }
  void source;
  return removals;
}

function findTypeDeclarationEnd(tokens: readonly ScannedToken[], start: number): number {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (text === "{") brace += 1;
    else if (text === "}") brace = Math.max(0, brace - 1);
    else if (text === "(") paren += 1;
    else if (text === ")") paren = Math.max(0, paren - 1);
    else if (text === "[") bracket += 1;
    else if (text === "]") bracket = Math.max(0, bracket - 1);
    if (text === ";" && brace === 0 && paren === 0 && bracket === 0) {
      return tokens[index]?.end ?? 0;
    }
    if (index > start && brace === 0 && paren === 0 && bracket === 0 && text === "}") {
      return tokens[index]?.end ?? 0;
    }
  }
  return tokens.at(-1)?.end ?? 0;
}

function findTypeExpressionEnd(tokens: readonly ScannedToken[], start: number): number {
  let angle = 0;
  let brace = 0;
  let bracket = 0;
  let paren = 0;
  let lastEnd = tokens[start]?.end ?? 0;
  for (let index = start + 1; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (text === "<") angle += 1;
    else if (text === ">" && angle > 0) angle -= 1;
    else if (text === "{") brace += 1;
    else if (text === "}" && brace > 0) brace -= 1;
    else if (text === "[") bracket += 1;
    else if (text === "]" && bracket > 0) bracket -= 1;
    else if (text === "(") paren += 1;
    else if (text === ")" && paren > 0) paren -= 1;
    if (
      angle === 0 &&
      brace === 0 &&
      bracket === 0 &&
      paren === 0 &&
      (text === "," ||
        text === ";" ||
        text === ")" ||
        text === "]" ||
        text === "}" ||
        text === "=" ||
        text === "=>" ||
        text === "?")
    ) {
      break;
    }
    lastEnd = tokens[index]?.end ?? lastEnd;
  }
  return lastEnd;
}

function isTypeArgumentList(tokens: readonly ScannedToken[], index: number): boolean {
  const end = matchingTokenIndex(tokens, index, "<", ">");
  return (
    end !== undefined &&
    tokens[end + 1]?.text === "(" &&
    (tokens[index - 1]?.isIdentifier === true || tokens[index - 1]?.text === ")")
  );
}

function matchingTokenEnd(
  tokens: readonly ScannedToken[],
  start: number,
  open: string,
  close: string,
): number | undefined {
  const index = matchingTokenIndex(tokens, start, open, close);
  return index === undefined ? undefined : tokens[index]?.end;
}

function matchingTokenIndex(
  tokens: readonly ScannedToken[],
  start: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (text === open) depth += 1;
    else if (text === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function isTypeAnnotation(tokens: readonly ScannedToken[], index: number): boolean {
  const previous = tokens[index - 1]?.text;
  if (previous === ")") {
    return true;
  }
  const parameterOpen = nearestOpenParen(tokens, index);
  if (parameterOpen !== undefined) {
    const close = matchingTokenIndex(tokens, parameterOpen, "(", ")");
    if (close !== undefined) {
      const after = tokens[close + 1]?.text;
      if (after === "=>" || after === "{" || after === ":") return true;
    }
  }
  if (previous && isVariableDeclaration(tokens, index)) return true;
  const next = tokens[index + 1]?.text;
  return next !== undefined && tokens[index + 2]?.text === "=>";
}

function nearestOpenParen(tokens: readonly ScannedToken[], index: number): number | undefined {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const text = tokens[cursor]?.text;
    if (text === ")") depth += 1;
    else if (text === "(") {
      if (depth === 0) return cursor;
      depth -= 1;
    }
  }
  return undefined;
}

function isVariableDeclaration(tokens: readonly ScannedToken[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const text = tokens[cursor]?.text;
    if (text === ";" || text === "{" || text === "}") return false;
    if (text === "const" || text === "let" || text === "var") return true;
  }
  return false;
}

function isNonNullAssertion(tokens: readonly ScannedToken[], index: number): boolean {
  const previous = tokens[index - 1]?.text;
  const next = tokens[index + 1]?.text;
  return previous !== undefined && next !== undefined && next !== "=" && next !== "!";
}

function deduplicateReplacements(
  replacements: readonly SourceReplacement[],
): readonly SourceReplacement[] {
  const seen = new Set<string>();
  return replacements.filter((replacement) => {
    const key = `${replacement.start}:${replacement.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nextToken(scanner: ReturnType<typeof createScanner>): Readonly<{
  readonly text: string;
  readonly end: number;
}> {
  const token = scanner.scan();
  if (token === SyntaxKind.EndOfFile) {
    throw sourceError("The workflow default result is incomplete.");
  }
  return {
    text: scanner.getTokenText(),
    end: scanner.getTokenEnd(),
  };
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
