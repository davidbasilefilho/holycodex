import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CORE_INSTRUCTIONS } from "./core-instructions.ts";

export type Rule = { readonly path: string; readonly body: string };
type HookInput = {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly transcript_path?: unknown;
  readonly tool_input?: unknown;
};

const DEFAULT_RULE_LIMIT = 8_000;
const DEFAULT_RESULT_LIMIT = 24_000;
const SOURCES = [".holycodex/rules", ".codex/rules", ".github/instructions"] as const;

/** Loads rules. */
export async function loadRules(cwd: string, targetPath?: string): Promise<readonly Rule[]> {
  if (process.env.HOLYCODEX_RULES_DISABLED === "1") return [];
  const candidates = [join(cwd, "CONTEXT.md"), join(cwd, ".github", "copilot-instructions.md")];
  for (const source of SOURCES) candidates.push(...(await markdownFiles(join(cwd, source))));
  const rules: Rule[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const path of candidates) {
    const text = await readable(path);
    if (text === undefined) continue;
    const parsed = parseRule(text);
    const staticSource = path.endsWith("CONTEXT.md") || path.endsWith("copilot-instructions.md");
    const matches =
      targetPath === undefined
        ? staticSource || parsed.alwaysApply
        : parsed.globs.some((glob) => globMatches(glob, relative(cwd, targetPath)));
    if (!matches || parsed.body.length === 0) continue;
    const body = parsed.body.slice(
      0,
      numberFromEnv("HOLYCODEX_RULES_MAX_RULE_CHARS", DEFAULT_RULE_LIMIT),
    );
    const hash = createHash("sha256").update(body).digest("hex");
    if (seen.has(hash)) continue;
    if (
      total + body.length >
      numberFromEnv("HOLYCODEX_RULES_MAX_RESULT_CHARS", DEFAULT_RESULT_LIMIT)
    )
      break;
    seen.add(hash);
    total += body.length;
    rules.push({ path, body });
  }
  return rules;
}

/** Runs rules hook. */
export async function runRulesHook(input: HookInput): Promise<string> {
  if (typeof input.cwd !== "string" || typeof input.session_id !== "string") return "";
  const event = input.hook_event_name;
  const cache = cachePath(input.session_id);
  if (event === "PostCompact") {
    await rm(cache, { force: true });
    return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: CORE_INSTRUCTIONS } })}\n`;
  }
  const target = event === "PostToolUse" ? editPath(input.tool_input, input.cwd) : undefined;
  if (event === "PostToolUse" && target === undefined) return "";
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "PostToolUse")
    return "";
  const rules = await loadRules(input.cwd, target);
  const transcript =
    typeof input.transcript_path === "string"
      ? ((await readable(input.transcript_path)) ?? "")
      : "";
  const emitted = await filterCached(cache, rules, transcript);
  if (emitted.length === 0) return "";
  const context = emitted
    .map((rule) => `Rule ${relative(input.cwd as string, rule.path)}:\n${rule.body}`)
    .join("\n\n");
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`;
}

function parseRule(text: string): {
  readonly alwaysApply: boolean;
  readonly globs: readonly string[];
  readonly body: string;
} {
  if (!text.startsWith("---\n")) return { alwaysApply: false, globs: [], body: text.trim() };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { alwaysApply: false, globs: [], body: text.trim() };
  const header = text.slice(4, end);
  return {
    alwaysApply: /^alwaysApply:\s*true\s*$/m.test(header),
    globs: parseGlobs(header),
    body: text.slice(end + 5).trim(),
  };
}

function parseGlobs(header: string): readonly string[] {
  const lines = header.split("\n");
  const index = lines.findIndex((line) => /^globs\s*:/.test(line));
  if (index < 0) return [];
  const value = lines[index]?.replace(/^globs\s*:\s*/, "").trim() ?? "";
  if (value.length > 0) {
    const inline = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
    return inline
      .split(",")
      .map(unquote)
      .filter((glob) => glob.length > 0);
  }
  const globs: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line)?.[1];
    if (item === undefined) break;
    const glob = unquote(item);
    if (glob.length > 0) globs.push(glob);
  }
  return globs;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function globMatches(glob: string, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const pattern = glob
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${pattern}$`).test(normalized);
}

async function markdownFiles(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory()
          ? markdownFiles(path)
          : entry.isFile() && entry.name.endsWith(".md")
            ? [path]
            : [];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readable(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function editPath(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = new Map(Object.entries(value));
  for (const key of ["filePath", "file_path", "path", "targetPath", "target_path"]) {
    const candidate = input.get(key);
    if (typeof candidate === "string")
      return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  }
  const patch =
    typeof input.get("patch") === "string"
      ? input.get("patch")
      : typeof input.get("input") === "string"
        ? input.get("input")
        : undefined;
  const path =
    patch === undefined
      ? undefined
      : /^\*\*\* (?:Add|Update) File: (.+)$/m.exec(patch)?.[1]?.trim();
  return path === undefined ? undefined : resolve(cwd, path);
}

async function filterCached(
  path: string,
  rules: readonly Rule[],
  transcript: string,
): Promise<readonly Rule[]> {
  const previous = new Set(JSON.parse((await readable(path)) ?? "[]") as readonly string[]);
  const emitted = rules.filter(
    (rule) => !previous.has(hashRule(rule)) && !transcript.includes(rule.body),
  );
  for (const rule of emitted) previous.add(hashRule(rule));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify([...previous]), "utf8");
  return emitted;
}

function hashRule(rule: Rule): string {
  return createHash("sha256").update(rule.body).digest("hex");
}

function cachePath(session: string): string {
  const root = process.env.PLUGIN_DATA ?? join(tmpdir(), "holycodex-plugin-data");
  return join(root, "rules", `${session.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
