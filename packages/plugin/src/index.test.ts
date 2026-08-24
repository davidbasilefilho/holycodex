// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { APPROVAL_POLICY_GUIDANCE } from "@holycodex/core";
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
  verifyPonytailMetadata,
} from "./index";
import { normalizeRelativePath } from "./source.ts";

describe("plugin source assets", () => {
  test("validates the complete owned source and independent capability roles", async () => {
    const source = await validateSource(pluginSourceRoot);
    expect(source.manifest.name).toBe("holycodex");
    expect(source.files.map((file) => file.path)).toContain(sourceManifestPath);
    expect(source.files.map((file) => file.path)).toContain("agents/explorer.md");
    expect(source.files.map((file) => file.path)).toContain("agents/librarian.md");
    expect(source.files.map((file) => file.path)).toContain("agents/worker.md");
    expect(source.files.map((file) => file.path)).toContain("agents/reviewer.md");

    const roles = await Promise.all(
      ["explorer", "librarian", "worker", "reviewer"].map(async (role) => {
        const text = await readFile(join(pluginSourceRoot, "agents", `${role}.md`), "utf8");
        return text;
      }),
    );
    expect(new Set(roles).size).toBe(4);
    for (const role of roles) {
      expect(role).toContain("Authority:");
      expect(role).toContain("Permitted tasks:");
      expect(role).toContain("Return");
      expect(role).toContain("Escalate");
      expect(role).toContain("Completion:");
      expect(role.toLowerCase()).toContain("delegate");
    }
    const [root, worker, rule] = await Promise.all([
      readFile(join(pluginSourceRoot, "agents", "root.md"), "utf8"),
      readFile(join(pluginSourceRoot, "agents", "worker.md"), "utf8"),
      readFile(join(pluginSourceRoot, "rules", "holycodex.md"), "utf8"),
    ]);
    for (const instruction of [root, worker, rule]) {
      expect(instruction).toContain("formatting");
      expect(instruction).toContain("linting");
      expect(instruction).toContain("tests");
      expect(instruction).toMatch(/no (?:additional|extra|user) approval/iu);
      expect(instruction.replaceAll(/\s+/gu, " ")).toContain(
        APPROVAL_POLICY_GUIDANCE.noRootApproval,
      );
      expect(instruction.replaceAll(/\s+/gu, " ")).toContain(APPROVAL_POLICY_GUIDANCE.rootApproval);
    }
  });

  test("keeps skill frontmatter, metadata, invocation, and server declarations in policy", async () => {
    const source = await validateSource(pluginSourceRoot);
    const skills = source.manifest.skills ?? [];
    expect(skills).toHaveLength(19);
    for (const skill of skills) {
      const body = await readFile(join(pluginSourceRoot, "skills", skill, "SKILL.md"), "utf8");
      const metadata = await readFile(
        join(pluginSourceRoot, "skills", skill, "agents", "openai.yaml"),
        "utf8",
      );
      if (skill === "ponytail") {
        expect(body).toContain("description: >");
        expect(body).toContain("name: ponytail");
        expect(body).toContain("Boundaries");
      } else {
        expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, "u"));
        expect(body).toContain("Owner:");
        expect(body).toContain("Boundary:");
        expect(body).toContain("Completion:");
      }
      expect(metadata).toContain("interface:");
      expect(metadata).toContain("default_prompt:");
      expect(metadata).toMatch(/allow_implicit_invocation: (true|false)/u);
      expect(`${body}\n${metadata}`.toLowerCase()).not.toContain("mcp");
      expect(`${body}\n${metadata}`).not.toContain(["0", "15", "0"].join("."));
    }
    const babysitMetadata = await readFile(
      join(pluginSourceRoot, "skills", "babysit-ci", "agents", "openai.yaml"),
      "utf8",
    );
    expect(babysitMetadata).toContain("allow_implicit_invocation: false");
    expect(source.manifest.hooks).toEqual(["hooks/manifest.json"]);
    expect(source.manifest.rules).toEqual(["rules/manifest.json", "rules/holycodex.md"]);
    expect(source.manifest.compaction).toEqual([
      "compaction/manifest.json",
      "compaction/holycodex.md",
    ]);
    expect(source.files.map((file) => file.path)).toContain("hooks/manifest.json");
    expect(source.files.map((file) => file.path)).toContain("rules/holycodex.md");
    expect(source.files.map((file) => file.path)).toContain("compaction/holycodex.md");
  });

  test("verifies vendored Ponytail metadata and rejects tampered bytes", async () => {
    const readBytes = (path: string): Promise<Uint8Array> => readFile(join(pluginSourceRoot, path));
    await expect(verifyPonytailMetadata(readBytes, "source_invalid")).resolves.toBeUndefined();

    await expect(
      verifyPonytailMetadata(async (path) => {
        const bytes = await readBytes(path);
        return path === "skills/ponytail/NOTICE" ? new Uint8Array([...bytes, 0]) : bytes;
      }, "source_invalid"),
    ).rejects.toMatchObject({ code: "digest_invalid" });
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
      expect(sourceManifest["version"]).toBeUndefined();
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
      await writeFile(join(changedRoot, "agents", "worker.md"), "changed bytes\n");
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

      await rm(join(missingRoot, "agents", "worker.md"));
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
      await writeFile(join(staging, "agents", "worker.md"), "corruption\n");
      await expect(verifyPayload(staging)).rejects.toBeInstanceOf(PluginError);
      await expect(verifyPayload(staging)).rejects.toMatchObject({ code: "digest_invalid" });
    } finally {
      await removeTemporary(sourceRoot, staging, occupied);
    }
  });

  test("keeps Windows and Git Bash executable-style paths outside relative assets", () => {
    expect(normalizeRelativePath("agents\\worker.md")).toBe("agents/worker.md");
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
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills", "sample", "agents"), { recursive: true });
  await writeFile(
    join(root, sourceManifestPath),
    `${JSON.stringify(
      {
        name: "sample-plugin",
        description: "A deterministic fixture.",
        skills: ["sample"],
        assets: ["agents/worker.md"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, "agents", "worker.md"), "worker fixture\n");
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
        description: "A deterministic fixture.",
        skills: ["sample"],
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
