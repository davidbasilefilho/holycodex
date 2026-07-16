import { access } from "node:fs/promises";
import { join } from "node:path";
import { CORE_INSTRUCTIONS } from "./core-instructions.ts";
import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../packages/git-bash-mcp/src/git-bash-resolver.ts";

const REQUIRED = ["git-bash.js", "lsp.js", "rules.js"] as const;

export async function readinessContext(
  pluginRoot: string,
  gitBash: GitBashResolution = resolveGitBashForCurrentProcess(),
): Promise<string> {
  const missing: string[] = [];
  for (const file of REQUIRED) {
    try {
      await access(join(pluginRoot, "runtime", file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missing.push(file);
      else throw error;
    }
  }
  const failures: string[] = [];
  if (missing.length > 0)
    failures.push(
      `missing runtime/${missing.join(", runtime/")}. Reinstall HolyCodex before using its local MCPs or hooks`,
    );
  if (!gitBash.found) failures.push(gitBash.installHint);
  return failures.length === 0
    ? CORE_INSTRUCTIONS
    : `${CORE_INSTRUCTIONS}\n\nHolyCodex incomplete: ${failures.join("; ")}.`;
}

export async function readinessOutput(pluginRoot: string): Promise<string> {
  const additionalContext = await readinessContext(pluginRoot);
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  })}\n`;
}
