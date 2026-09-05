// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PluginError,
  assemblePayload,
  defaultSchemaEpoch,
  payloadManifestPath,
  planAssembly,
  pluginSourceRoot,
  sourceManifestPath,
  validateSource,
  verifyPayload,
} from "./index";
import { normalizeRelativePath } from "./source.ts";

describe("plugin source assets", () => {
  test("keeps the checked-in Codex manifest on the canonical CLI version", async () => {
    const pluginManifest = JSON.parse(
      await readFile(join(pluginSourceRoot, ".codex-plugin", "plugin.json"), "utf8"),
    ) as { readonly version?: unknown };
    const cliManifest = JSON.parse(
      await readFile(resolve(pluginSourceRoot, "../../cli/package.json"), "utf8"),
    ) as { readonly version?: unknown };
    expect(pluginManifest.version).toBe(cliManifest.version);
  });

  test("validates the current owned source and skill policy", async () => {
    const source = await validateSource(pluginSourceRoot);
    expect(source.manifest.name).toBe("holycodex");
    expect(source.files.map((file) => file.path)).toContain(sourceManifestPath);
    expect(source.files.map((file) => file.path)).toContain("skills/plan/SKILL.md");
    expect(source.files.map((file) => file.path)).toContain("skills/operations/SKILL.md");
    const defaultPrompt = source.manifest.interface.defaultPrompt.join("\n");
    expect(defaultPrompt).toContain("Activate HolyCodex");
    expect(defaultPrompt).toContain("generated Root developer instructions");
    expect(defaultPrompt).toContain("holycodex-agent");
    expect(defaultPrompt).not.toContain("delegate every task");
    expect(defaultPrompt).not.toContain("Reviewer.code");
    expect(defaultPrompt).not.toContain("request_user_input");
    expect(defaultPrompt).not.toContain("surgical-mutation rule");
  });

  test("keeps skill frontmatter, metadata, invocation, and server declarations in policy", async () => {
    const source = await validateSource(pluginSourceRoot);
    const skills = source.files
      .map((file) => /^skills\/([^/]+)\/SKILL\.md$/u.exec(file.path)?.[1])
      .filter((skill): skill is string => skill !== undefined);
    expect(source.manifest.skills).toBe("./skills");
    for (const skill of skills) {
      const body = await readFile(join(pluginSourceRoot, "skills", skill, "SKILL.md"), "utf8");
      const metadata = await readFile(
        join(pluginSourceRoot, "skills", skill, "agents", "openai.yaml"),
        "utf8",
      );
      if (skill === "stop-slop") {
        expect(body).toContain("references/phrases.md");
        expect(body).toContain("references/structures.md");
        expect(body).toContain("references/examples.md");
      } else {
        expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, "u"));
      }
      if (skill === "writing-for-agents") {
        expect(body).toContain("SKILL-MECHANICS.md");
        expect(body).toContain("context pointer");
        expect(body).toContain("reload only when the current context");
        expect(body).not.toContain("reload after compaction");
        expect(body).toContain("Owner:");
        expect(body).toContain("Boundary:");
        expect(body).toContain("Completion:");
        expect(body).toContain("Return:");
        expect(body).not.toContain("For Sol");
        expect(body).not.toContain("For Luna");
      }
      expect(metadata).toContain("interface:");
      expect(metadata).toContain("default_prompt:");
      expect(metadata).toMatch(/allow_implicit_invocation: (true|false)/u);
      expect(`${body}\n${metadata}`.toLowerCase()).not.toContain("mcp");
      expect(`${body}\n${metadata}`).not.toContain(["0", "15", "0"].join("."));
    }
  });

  test("hardens Root orchestration and semantic state ownership", async () => {
    const requiredSkills = [
      "plan",
      "plan-review",
      "programming",
      "debugging",
      "code-review",
      "operations",
    ];
    for (const skill of requiredSkills) {
      const body = await readFile(join(pluginSourceRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(body).toContain("holycodex-agent");
      expect(body).toMatch(/delegat(?:e|ed|ion)/iu);
      expect(body).toMatch(/completed.*blocked.*needs_root_input.*failed/isu);
    }

    const plan = await readFile(join(pluginSourceRoot, "skills", "plan", "SKILL.md"), "utf8");
    expect(plan).toContain("trivial work");
    expect(plan).toContain("delegated plan/review assignments");
    expect(plan).toContain("request_user_input");
    expect(plan).toContain("Do not edit TOON files manually");

    const handoff = await readFile(join(pluginSourceRoot, "skills", "handoff", "SKILL.md"), "utf8");
    expect(handoff).toContain("projection/export only");
    expect(handoff).toContain("no second source of truth");
    expect(handoff).not.toContain("write one redacted handoff");

    const commit = await readFile(join(pluginSourceRoot, "skills", "commit", "SKILL.md"), "utf8");
    expect(commit).toContain("only unconditional direct execution exception");
    expect(commit).toContain("surgical-mutation rule");
    expect(commit).toContain("Reviewer.code fixed-point");
    expect(commit).toContain("request_user_input");
  });

  test("keeps every write-capable skill Assignment-bounded and outcome-oriented", async () => {
    const writeSkills = [
      "code-review",
      "compress",
      "debugging",
      "operations",
      "programming",
      "refactor",
      "rules",
      "stop-slop",
    ];
    for (const skill of writeSkills) {
      const body = await readFile(join(pluginSourceRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(body).toMatch(/Owner: (?:Worker|Reviewer)/u);
      expect(body).toContain("delegated Assignment");
      expect(body).toContain("surgical-mutation rule");
      expect(body).toMatch(/TOON files\s+manually/u);
      expect(body).toMatch(/completed.*blocked.*needs_root_input.*failed/isu);
      expect(body).toMatch(/holycodex-agent assignment\s+result/u);
    }
  });
});

describe("deterministic payload assembly", () => {
  test("injects version only into staged metadata and verifies a deterministic identity", async () => {
    const sourceRoot = await createFixture();
    const stagingA = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-a-"));
    const stagingB = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-b-"));
    try {
      const plan = await planAssembly({
        sourceRoot,
        stagingDirectory: stagingA,
        version: "0.1.0",
      });
      expect(plan.identity.version).toBe("0.1.0");
      const first = await assemblePayload({
        sourceRoot,
        stagingDirectory: stagingA,
        version: "0.1.0",
      });
      const second = await assemblePayload({
        sourceRoot,
        stagingDirectory: stagingB,
        version: "0.1.0",
      });
      expect(first.identity).toEqual(second.identity);
      expect(first.manifest.files).toEqual(second.manifest.files);
      expect(first.identity.epoch).toBe(defaultSchemaEpoch);

      const sourceManifest = JSON.parse(
        await readFile(join(sourceRoot, sourceManifestPath), "utf8"),
      ) as Record<string, unknown>;
      const stagedManifest = JSON.parse(
        await readFile(join(stagingA, sourceManifestPath), "utf8"),
      ) as Record<string, unknown>;
      expect(sourceManifest["version"]).toBe("0.1.0");
      expect(stagedManifest["version"]).toBe("0.1.0");
      const verified = await verifyPayload(stagingA);
      expect(verified.identity).toEqual(first.identity);
      expect(verified.manifest).toEqual(first.manifest);
    } finally {
      await removeTemporary(sourceRoot, stagingA, stagingB);
    }
  });

  test("changes identity for different bytes and for a different schema epoch", async () => {
    const sourceRoot = await createFixture();
    const changedRoot = await createFixture();
    const stagingA = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-byte-a-"));
    const stagingB = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-byte-b-"));
    const stagingC = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-epoch-"));
    try {
      await writeFile(join(changedRoot, "skills", "sample", "SKILL.md"), "changed bytes\n");
      const first = await assemblePayload({
        sourceRoot,
        stagingDirectory: stagingA,
        version: "0.1.0",
      });
      const changed = await assemblePayload({
        sourceRoot: changedRoot,
        stagingDirectory: stagingB,
        version: "0.1.0",
      });
      const epoch = await assemblePayload({
        sourceRoot,
        stagingDirectory: stagingC,
        version: "0.1.0",
        schemaEpoch: "plugin-2",
      });
      expect(changed.identity.digest).not.toBe(first.identity.digest);
      expect(epoch.identity.digest).not.toBe(first.identity.digest);
      expect(epoch.identity.epoch).toBe("plugin-2");
    } finally {
      await removeTemporary(sourceRoot, changedRoot, stagingA, stagingB, stagingC);
    }
  });

  test("rejects traversal, symlinks, secret paths, missing files, and extra files", async () => {
    const traversalRoot = await createFixture();
    const symlinkRoot = await createFixture();
    const secretRoot = await createFixture();
    const missingRoot = await createFixture();
    const extraRoot = await createFixture();
    try {
      await setManifestAssets(traversalRoot, ["../outside.md"]);
      await expect(validateSource(traversalRoot)).rejects.toMatchObject({
        code: "manifest_invalid",
      });

      await symlink(
        join(symlinkRoot, "agents"),
        join(symlinkRoot, "linked-agents"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(validateSource(symlinkRoot)).rejects.toMatchObject({ code: "path_invalid" });

      await writeFile(join(secretRoot, ".env"), "secret=true\n");
      await expect(validateSource(secretRoot)).rejects.toMatchObject({ code: "path_invalid" });

      await rm(join(missingRoot, "skills", "sample", "SKILL.md"));
      await expect(validateSource(missingRoot)).rejects.toMatchObject({ code: "source_invalid" });

      await writeFile(join(extraRoot, "extra.md"), "extra\n");
      await expect(validateSource(extraRoot)).rejects.toMatchObject({ code: "source_invalid" });
    } finally {
      await removeTemporary(traversalRoot, symlinkRoot, secretRoot, missingRoot, extraRoot);
    }
  });

  test("refuses non-empty staging and detects digest corruption", async () => {
    const sourceRoot = await createFixture();
    const staging = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-corrupt-"));
    const occupied = await mkdtemp(join(tmpdir(), "holycodex-plugin-stage-occupied-"));
    try {
      await expect(
        assemblePayload({
          sourceRoot,
          stagingDirectory: staging,
          version: "0.1.0",
          unexpected: true,
        }),
      ).rejects.toMatchObject({ code: "source_invalid" });
      await writeFile(join(occupied, "existing.txt"), "occupied\n");
      await expect(
        assemblePayload({ sourceRoot, stagingDirectory: occupied, version: "0.1.0" }),
      ).rejects.toMatchObject({ code: "staging_invalid" });

      await assemblePayload({ sourceRoot, stagingDirectory: staging, version: "0.1.0" });
      await writeFile(join(staging, "skills", "sample", "SKILL.md"), "corruption\n");
      await expect(verifyPayload(staging)).rejects.toBeInstanceOf(PluginError);
      await expect(verifyPayload(staging)).rejects.toMatchObject({ code: "digest_invalid" });
    } finally {
      await removeTemporary(sourceRoot, staging, occupied);
    }
  });

  test("keeps Windows and Git Bash executable-style paths outside relative assets", () => {
    expect(normalizeRelativePath("skills\\sample\\SKILL.md")).toBe("skills/sample/SKILL.md");
    expect(() => normalizeRelativePath("C:\\Users\\codex\\worker.md")).toThrow(
      /inside their source root|relative/u,
    );
    expect(() => normalizeRelativePath("/c/Users/codex/worker.md")).toThrow(
      /inside their source root|relative/u,
    );
    expect(() => normalizeRelativePath("skills\\..\\worker.md")).toThrow(/traverse/u);
  });
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "holycodex-plugin-source-"));
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "sample", "agents"), { recursive: true });
  await writeFile(
    join(root, sourceManifestPath),
    `${JSON.stringify(
      {
        name: "sample-plugin",
        version: "0.1.0",
        description: "A deterministic fixture.",
        author: { name: "Fixture Author" },
        skills: "./skills",
        interface: {
          displayName: "Sample",
          shortDescription: "Sample fixture.",
          longDescription: "Sample fixture plugin.",
          developerName: "Fixture Author",
          category: "Developer Tools",
          capabilities: ["Skills"],
          defaultPrompt: ["Use the sample fixture."],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(root, "skills", "sample", "SKILL.md"),
    "---\nname: sample\ndescription: fixture\n---\n",
  );
  await writeFile(join(root, "skills", "sample", "agents", "openai.yaml"), "interface: {}\n");
  return root;
}

async function setManifestAssets(root: string, assets: readonly string[]): Promise<void> {
  await writeFile(
    join(root, sourceManifestPath),
    `${JSON.stringify(
      {
        name: "sample-plugin",
        version: "0.1.0",
        description: "A deterministic fixture.",
        author: { name: "Fixture Author" },
        skills: assets[0] ?? "./skills",
        interface: {
          displayName: "Sample",
          shortDescription: "Sample fixture.",
          longDescription: "Sample fixture plugin.",
          developerName: "Fixture Author",
          category: "Developer Tools",
          capabilities: ["Skills"],
          defaultPrompt: ["Use the sample fixture."],
        },
        assets,
      },
      null,
      2,
    )}\n`,
  );
}

async function removeTemporary(...paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

void payloadManifestPath;
