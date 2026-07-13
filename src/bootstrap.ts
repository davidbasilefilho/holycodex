import { access } from "node:fs/promises";
import { join } from "node:path";

const REQUIRED = ["git-bash.js", "lsp.js", "rules.js"] as const;

export async function readinessContext(pluginRoot: string): Promise<string> {
  const missing: string[] = [];
  for (const file of REQUIRED) {
    try {
      await access(join(pluginRoot, "runtime", file));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") missing.push(file);
      else throw error;
    }
  }
  return missing.length === 0
    ? ""
    : `HolyCodex incomplete: missing runtime/${missing.join(", runtime/")}. Reinstall HolyCodex before using its local MCPs or hooks.`;
}
