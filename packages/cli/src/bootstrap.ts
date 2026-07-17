import { access } from "node:fs/promises";
import { join } from "node:path";
import { coreInstructions } from "./core-instructions.ts";
import { requiredRuntimes } from "./catalog.ts";
import {
  resolveGitBashForCurrentProcess,
  type GitBashResolution,
} from "../../git-bash-mcp/src/git-bash-resolver.ts";

export async function readinessContext(
  pluginRoot: string,
  platform: NodeJS.Platform,
  gitBash: GitBashResolution,
): Promise<string> {
  const missing: string[] = [];
  for (const file of requiredRuntimes(platform)) {
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
  if (platform === "win32" && !gitBash.found) failures.push(gitBash.installHint);
  const instructions = coreInstructions(platform);
  return failures.length === 0
    ? instructions
    : `${instructions}\n\nHolyCodex incomplete: ${failures.join("; ")}.`;
}

export async function readinessOutput(
  pluginRoot: string,
  platform: NodeJS.Platform = process.platform,
  gitBash: GitBashResolution = resolveGitBashForCurrentProcess({ platform }),
): Promise<string> {
  const additionalContext = await readinessContext(pluginRoot, platform, gitBash);
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  })}\n`;
}
