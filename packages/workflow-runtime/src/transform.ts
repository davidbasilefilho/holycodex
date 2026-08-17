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
      `globalThis.__workflow = async (args, runtime, agent, pipeline) => {\n${rewritten}\n};`,
    );
  } catch {
    throw sourceError("The workflow TypeScript source is invalid.");
  }
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
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
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
