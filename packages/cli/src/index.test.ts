// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  doctorHolyCodex,
  executeWorkflowCommand,
  installHolyCodex,
  parseArgv,
  readMarketplace,
  resolveInstallerPaths,
  runCli,
} from "./index.ts";
import { CodexOfficialPluginManager } from "./index.ts";
import type { OfficialPluginManager, WorkflowService } from "./index.ts";

describe("CLI argument and envelope boundaries", () => {
  test("rejects option conflicts, unknown options, and stray positionals", () => {
    expect(() => parseArgv(["install", "--computer-use", "--no-computer-use"])).toThrow();
    expect(() => parseArgv(["doctor", "--unknown"])).toThrow();
    expect(() => parseArgv(["doctor", "extra"])).toThrow();
    expect(() => parseArgv(["workflow", "show", "run-1", "extra"])).toThrow();
    expect(() => parseArgv(["workflow", "inspect", "run-1", "extra"])).toThrow();
    expect(parseArgv(["cleanup", "--scope", "expired", "--json"]).command).toBe("cleanup");
    expect(() => parseArgv(["workflow", "run", "workflow.ts", "--name", "legacy"])).toThrow();
    expect(parseArgv(["workflow", "run", "-", "--task", "stdin objective"]).options["task"]).toBe(
      "stdin objective",
    );
  });

  test("resupplies resume source and args to the durable host", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-resume-");
    const sourcePath = join(root, "workflow.ts");
    await writeFile(sourcePath, "return { resumed: true };\n");
    let received: Parameters<NonNullable<WorkflowService["resume"]>>[0] | undefined;
    const service: WorkflowService = {
      resume: async (input) => {
        received = input;
        throw new Error("resume sentinel");
      },
    };
    await expect(
      executeWorkflowCommand(
        parseArgv(["workflow", "resume", "run-1", sourcePath, '{"input":1}']),
        {
          cwd: root,
          trustGate: async () => true,
          workflowService: service,
        },
      ),
    ).rejects.toThrow("resume sentinel");
    expect(received).toEqual({
      runId: "run-1",
      source: "return { resumed: true };\n",
      args: { input: 1 },
    });
    await rm(root, { recursive: true, force: true });
  });

  test("fails closed when the official plugin list is not an array envelope", async () => {
    const manager = new CodexOfficialPluginManager({
      run: async () => ({ exitCode: 0, stdout: "null", stderr: "" }),
    });
    await expect(manager.list()).rejects.toMatchObject({ code: "list_failed" });
  });

  test("emits one validated JSON envelope and never prompts without --yes", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-envelope-");
    try {
      const result = await runCli(
        [
          "install",
          "--json",
          "--codex-home",
          join(root, "home"),
          "--marketplace-root",
          join(root, "market"),
        ],
        {
          io: {
            stdoutIsTTY: false,
            stderrIsTTY: false,
            confirm: async () => {
              throw new Error("prompted");
            },
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.envelope.ok).toBe(false);
      if (!result.envelope.ok) {
        expect(result.envelope.error.code).toBe("non_tty_confirmation_required");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("owned installation", () => {
  test("preserves marketplace order and converges idempotently", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-market-");
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    try {
      await mkdir(paths.marketplaceRoot, { recursive: true });
      await writeFile(
        join(paths.marketplaceRoot, "marketplace.json"),
        `${JSON.stringify({ owner: { name: "other" }, plugins: [{ name: "other" }, { name: "another" }] })}\n`,
      );
      const first = await installHolyCodex({}, { paths });
      const second = await installHolyCodex({}, { paths });
      const marketplace = await readMarketplace(join(paths.marketplaceRoot, "marketplace.json"));
      expect(second.record.artifact_id).toBe(first.record.artifact_id);
      expect(marketplace.plugins.map((entry) => entry["name"])).toEqual([
        "other",
        "another",
        "holycodex",
      ]);
      expect(marketplace.plugins.at(-1)?.["source"]).toBe(first.record.relative_path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("activates changed bytes at the same reported version and prunes only after verification", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-regression-");
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    try {
      await createSource(sourceA, "A bytes\n");
      await createSource(sourceB, "B bytes\n");
      const first = await installHolyCodex({}, { paths, sourceRoot: sourceA });
      const second = await installHolyCodex({}, { paths, sourceRoot: sourceB });
      const doctor = await doctorHolyCodex({ paths });
      const activeBytes = await readFile(
        join(paths.marketplaceRoot, second.record.relative_path.slice(2), "agents", "worker.md"),
        "utf8",
      );
      const payloads = await readdir(join(paths.marketplaceRoot, "plugins", "holycodex"));
      expect(first.record.version).toBe(second.record.version);
      expect(first.record.artifact_id).not.toBe(second.record.artifact_id);
      expect(activeBytes).toBe("B bytes\n");
      expect(payloads).toEqual([second.record.artifact_id]);
      expect(doctor.healthy).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses fresh-off defaults, preserves omitted upgrade choices, and calls only selected official plugins", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-options-");
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    const calls: string[] = [];
    const manager: OfficialPluginManager = {
      list: async () => [{ name: "sample", version: "1.0.0", description: "sample" }],
      add: async (plugin) => {
        calls.push(plugin.manifest.name);
      },
    };
    try {
      const first = await installHolyCodex(
        { optional: { work: true }, officialPlugins: ["sample"] },
        { paths, officialPluginManager: manager },
      );
      const second = await installHolyCodex({}, { paths, officialPluginManager: manager });
      expect(first.record.optional_selections).toEqual({
        computer_use: false,
        work: true,
        web: false,
        security: false,
        coding: true,
      });
      expect(second.record.optional_selections.work).toBe(true);
      expect(second.record.optional_selections.web).toBe(false);
      expect(calls).toEqual(["sample"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("installer recovery and cleanup boundaries", () => {
  test("recovers only a validated stale lock and rejects traversal or symlink roots", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-boundary-");
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    try {
      await mkdir(paths.codexHome, { recursive: true });
      const resolved = resolveInstallerPaths({ paths });
      await mkdir(resolved.lock, { recursive: true });
      await writeFile(
        join(resolved.lock, "owner.json"),
        `${JSON.stringify({ owner_pid: 99999999, run_id: "stale", started_at: new Date(0).toISOString(), expires_at: 1 })}\n`,
      );
      const recovered = await installHolyCodex({}, { paths });
      expect(recovered.recovered_lock).toBe(true);
      await expect(
        installHolyCodex(
          {},
          { paths: { codexHome: `${root}/../escape`, marketplaceRoot: join(root, "market-2") } },
        ),
      ).rejects.toMatchObject({ code: "invalid_path" });
      const symlinkTarget = join(root, "symlink-target");
      await mkdir(symlinkTarget, { recursive: true });
      const symlinkPath = join(root, "symlink-market");
      await symlink(symlinkTarget, symlinkPath);
      await expect(
        installHolyCodex(
          {},
          { paths: { codexHome: join(root, "home-2"), marketplaceRoot: symlinkPath } },
        ),
      ).rejects.toMatchObject({ code: "path_symlink" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleanup is compare-gated and idempotent", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-cleanup-");
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    try {
      const installed = await installHolyCodex({}, { paths });
      const marketplacePath = join(paths.marketplaceRoot, "marketplace.json");
      const marketplace = await readMarketplace(marketplacePath);
      const changed = {
        ...marketplace,
        plugins: marketplace.plugins.map((entry) =>
          entry["name"] === "holycodex" ? { ...entry, source: "./edited" } : entry,
        ),
      };
      await writeFile(marketplacePath, `${JSON.stringify(changed)}\n`);
      const maintenance = await import("./maintenance.ts");
      const preserved = await maintenance.cleanupHolyCodex("workspace", { paths }, { yes: true });
      expect(preserved.reasons).toContain("effect_uncertain");
      expect(preserved.preserved).toContain("marketplace:holycodex");
      await writeFile(marketplacePath, `${JSON.stringify(marketplace)}\n`);
      const removed = await maintenance.cleanupHolyCodex("workspace", { paths }, { yes: true });
      const repeated = await maintenance.cleanupHolyCodex("workspace", { paths }, { yes: true });
      expect(removed.removed).toContain("marketplace:holycodex");
      expect(repeated.removed).toEqual([]);
      expect(installed.record.artifact_id).toContain("artifact-");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workflow dispatch", () => {
  test("uses task as the run objective and requires task for stdin", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-task-");
    const source = join(root, "workflow.ts");
    await writeFile(source, "return { ok: true };\n");
    let created:
      | { readonly objective: string; readonly source: string; readonly args: unknown }
      | undefined;
    const service: WorkflowService = {
      create: async (input) => {
        created = input;
        throw new Error("create sentinel");
      },
    };
    try {
      await expect(
        executeWorkflowCommand(parseArgv(["workflow", "run", source, '{"n":1}']), {
          cwd: root,
          trustGate: async () => true,
          workflowService: service,
        }),
      ).rejects.toThrow("create sentinel");
      expect(created).toEqual({
        objective: "workflow:workflow",
        source: "return { ok: true };\n",
        args: { n: 1 },
      });

      await expect(
        executeWorkflowCommand(parseArgv(["workflow", "run", "-", "--json"]), {
          io: {
            stdin: (async function* () {
              yield "return 1;\n";
            })(),
          },
          workflowService: service,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("trust-gates files and validates JSON args before dispatch", async () => {
    const root = await mkdtemp("/tmp/holycodex-cli-workflow-");
    const source = join(root, "workflow.ts");
    await writeFile(source, "return { ok: true };\n");
    const service: WorkflowService = {
      save: async (_scope, name) => ({ saved: name }),
      invoke: async (_scope, name, args) => ({ name, args }),
      list: async () => [],
    };
    try {
      const denied = await runCli(["workflow", "save", "project", "demo", source, "--json"], {
        cwd: root,
        workflowService: service,
        trustGate: async () => false,
      });
      expect(denied.exitCode).toBe(4);
      const malformed = await runCli(["workflow", "save", "project", "demo", source, "--json"], {
        cwd: root,
        workflowService: service,
        trustGate: async () => true,
      });
      expect(malformed.exitCode).toBe(0);
      const badArgs = await runCli(["workflow", "invoke", "user", "demo", "not-json", "--json"], {
        cwd: root,
        workflowService: service,
      });
      expect(badArgs.exitCode).toBe(1);
      const listed = await runCli(["workflow", "list", "--json"], { workflowService: service });
      expect(listed.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createSource(root: string, worker: string): Promise<void> {
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "holycodex", description: "fixture", assets: ["agents/worker.md"] })}\n`,
  );
  await writeFile(join(root, "agents", "worker.md"), worker);
}
