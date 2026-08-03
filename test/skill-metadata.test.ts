import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SKILLS } from "../packages/cli/src/catalog";

const root = join(import.meta.dirname, "..");
const skillsRoot = join(root, "packages", "plugin", "plugin", "skills");
const run = promisify(execFile);
const manualTitles = {
  "ast-grep": "AST Grep",
  "babysit-ci": "Babysit CI",
  "code-review": "Code Review",
  compress: "Compress",
  "context7-cli": "Context7 CLI",
  debugging: "Debugging",
  handoff: "Handoff",
  lsp: "LSP",
  "lsp-setup": "LSP Setup",
  plan: "Plan",
  "plan-review": "Plan Review",
  programming: "Programming",
  refactor: "Refactor",
  "remove-slop": "Remove Slop",
  rules: "Rules",
} satisfies Record<(typeof SKILLS)[number], string>;
const metadataSchema = z.strictObject({
  interface: z.strictObject({
    display_name: z.string(),
    short_description: z.string().min(25).max(64),
    default_prompt: z.string(),
  }),
});

async function parseYaml(path: string): Promise<unknown> {
  const script =
    "const value = Bun.YAML.parse(await Bun.file(process.argv[1]).text());" +
    "process.stdout.write(JSON.stringify(value));";
  const { stdout } = await run("bun", ["-e", script, path]);
  return JSON.parse(stdout) as unknown;
}

describe("bundled skill UI metadata", () => {
  it("ships the full plugin tree in the published package", async () => {
    const packageJson = JSON.parse(
      await readFile(join(root, "packages", "plugin", "package.json"), "utf8"),
    ) as { files?: string[] };
    expect(packageJson.files).toContain("plugin");
  });

  it("covers exactly the canonical skill catalog", async () => {
    const metadataSkills: string[] = [];
    for (const skill of await readdir(skillsRoot)) {
      const agentsDirectory = join(skillsRoot, skill, "agents");
      if ((await readdir(agentsDirectory)).includes("openai.yaml")) metadataSkills.push(skill);
    }
    expect(metadataSkills.sort()).toEqual([...SKILLS].sort());
    expect(Object.keys(manualTitles).sort()).toEqual([...SKILLS].sort());
  });

  it("parses and validates every metadata document", async () => {
    for (const skill of SKILLS) {
      const path = join(skillsRoot, skill, "agents", "openai.yaml");
      const source = await readFile(path, "utf8");
      const metadata = metadataSchema.parse(await parseYaml(path));
      expect(source).not.toContain("\t");
      expect(metadata.interface.display_name).toBe(`HolyCodex: ${manualTitles[skill]}`);
      expect(metadata.interface.default_prompt).toMatch(
        new RegExp(`(?:^|\\s)\\$${skill.replaceAll("-", "\\-")}(?:\\s|$)`),
      );
    }
  });
});
