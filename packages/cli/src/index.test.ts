// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import type { JsonObject, JsonValue } from "@holycodex/core";
import { CAPABILITY_REGISTRY } from "@holycodex/core";
import {
  acquireInstallLock,
  doctorHolyCodex,
  executeWorkflowCommand,
  installHolyCodex,
  parseArgv,
  pathWithin,
  readCanonicalVersion,
  readMarketplace,
  resolveInstallerPaths,
  runBinary,
  runCli,
  assertRootText,
} from "./index.ts";
import { CodexOfficialPluginManager } from "./index.ts";
import type { OfficialPluginManager, WorkflowService } from "./index.ts";

function generatedWorkflowTestBoundary() {
  return {
    assertOwnedPath: async (root: string, candidate: string, allowMissing: boolean) => {
      if (root !== candidate && !pathWithin(root, candidate))
        throw new Error("test boundary escape");
      const entry = await lstat(candidate).catch((error: unknown) => {
        if (
          allowMissing &&
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      });
      if (entry?.isSymbolicLink()) throw new Error("test boundary symlink");
    },
    ensureDirectory: async (_root: string, candidate: string) => {
      await mkdir(candidate, { recursive: true });
    },
    writeAtomicFile: async (_root: string, candidate: string, bytes: Uint8Array) => {
      await writeFile(candidate, bytes, { mode: 0o600 });
    },
    readOwnedFile: async (_root: string, candidate: string) => await readFile(candidate),
    readDirectory: async (_root: string, candidate: string) =>
      (await readdir(candidate, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink()
          ? ("symlink" as const)
          : entry.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
      })),
    removeOwnedDirectory: async (_root: string, candidate: string) => {
      await rm(candidate, { recursive: true, force: false });
    },
  } as const;
}

describe("CLI argument and envelope boundaries", () => {
  test("rejects option conflicts, unknown options, and stray positionals", () => {
    expect(() => parseArgv(["install", "--computer-use", "--no-computer-use"])).toThrow();
    expect(() => parseArgv(["doctor", "--unknown"])).toThrow();
    expect(() => parseArgv(["doctor", "extra"])).toThrow();
    expect(() => parseArgv(["workflow", "show", "run-1", "extra"])).toThrow();
    expect(() => parseArgv(["workflow", "inspect", "run-1", "extra"])).toThrow();
    expect(parseArgv(["cleanup", "--scope", "expired", "--json"]).command).toBe("cleanup");
    expect(parseArgv(["--version"]).command).toBe("version");
    expect(parseArgv(["-v"]).command).toBe("version");
    expect(parseArgv(["--help"]).command).toBe("help");
    expect(parseArgv(["workflow", "continue", "run-1", "workflow.ts"]).command).toBe(
      "workflow continuation",
    );
    expect(parseArgv(["workflow", "run", "workflow.ts", "--fast"]).options["fast"]).toBe(true);
    expect(parseArgv(["workflow", "run", "workflow.ts", "--no-tui"]).options["no-tui"]).toBe(true);
    expect(
      parseArgv(["workflow", "create", "workflow.ts", "--name", "review", "--session-id", "s1"])
        .command,
    ).toBe("workflow create");
    expect(parseArgv(["workflow", "check", "workflow.ts"]).command).toBe("workflow check");
    expect(() => parseArgv(["workflow", "run", "workflow.ts", "--name", "legacy"])).toThrow();
    expect(parseArgv(["workflow", "run", "-", "--task", "stdin objective"]).options["task"]).toBe(
      "stdin objective",
    );
  });

  test("keeps help on stdout with no stderr and failures on stderr in human mode", async () => {
    let stdout = "";
    let stderr = "";
    const io = {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    };
    const helpExit = await runBinary(["workflow", "run", "--help"], io);
    expect(helpExit).toBe(0);
    expect(stdout).toContain("Workflow files must export");
    expect(stderr).toBe("");

    stdout = "";
    const canonicalVersion = await readCanonicalVersion();
    const versionExit = await runBinary(["-v"], io);
    expect(versionExit).toBe(0);
    expect(stdout).toContain(`version: ${canonicalVersion}`);
    expect(stderr).toBe("");

    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-no-tui-"));
    try {
      stdout = "";
      const noTuiExit = await runBinary(
        [
          "cleanup",
          "--scope",
          "workspace",
          "--no-tui",
          "--codex-home",
          join(root, "home"),
          "--marketplace-root",
          join(root, "market"),
        ],
        {
          ...io,
          stdoutIsTTY: true,
          confirm: async () => {
            throw new Error("prompted");
          },
        },
      );
      expect(noTuiExit).toBe(0);
      expect(stdout).toContain("preview  : true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    stdout = "";
    stderr = "";
    const failureExit = await runBinary(["doctor", "--unknown"], io);
    expect(failureExit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("invalid_argument");
  });

  test("normalizes Windows and Git Bash fixture paths without allowing traversal", () => {
    const windowsRoot = assertRootText("C:\\Users\\codex\\.codex", "CODEX_HOME", "win32");
    const gitBashRoot = assertRootText("/c/Users/codex/.codex", "CODEX_HOME", "win32");
    expect(windowsRoot).toBe("C:\\Users\\codex\\.codex");
    expect(gitBashRoot).toBe(windowsRoot);
    expect(pathWithin(windowsRoot, "C:\\Users\\codex\\.codex\\runs", "win32")).toBe(true);
    expect(pathWithin(windowsRoot, "C:\\Users\\other", "win32")).toBe(false);
    expect(() => assertRootText("C:\\Users\\codex\\..\\other", "CODEX_HOME", "win32")).toThrow(
      /traversal/u,
    );
  });

  test("resupplies resume source and args to the durable host", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-resume-"));
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

  test("bounds workflow source before loading or dispatching it", async () => {
    const parsed = parseArgv(["workflow", "run", "-", "--task", "bounded input"]);
    await expect(
      executeWorkflowCommand(parsed, {
        readStdin: async () => "x".repeat(1024 * 1024 + 1),
        workflowService: {
          create: async () => {
            throw new Error("source should be rejected before dispatch");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("fails closed when the official plugin list is not an array envelope", async () => {
    const manager = new CodexOfficialPluginManager({
      run: async () => ({ exitCode: 0, stdout: "null", stderr: "" }),
    });
    await expect(manager.list()).rejects.toMatchObject({ code: "list_failed" });
  });

  test("reports listed official plugins as installed and absent selections as missing", async () => {
    const manager = new CodexOfficialPluginManager({
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [{ pluginId: "sample", installed: true, enabled: true }],
          available: [],
        }),
        stderr: "",
      }),
    });
    await expect(manager.status(["sample", "other"])).resolves.toEqual({
      sample: "installed",
      other: "missing",
    });
  });

  test("emits one validated JSON envelope and never prompts without --yes", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-envelope-"));
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
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-market-"));
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
      expect(marketplace.name).toBe("holycodex");
      expect(marketplace.plugins.map((entry) => entry["name"])).toEqual([
        "other",
        "another",
        "holycodex",
      ]);
      expect(marketplace.plugins.at(-1)?.["source"]).toEqual({
        source: "local",
        path: first.record.relative_path,
      });
      expect(
        await readFile(join(paths.codexHome, "holycodex", "journal.ndjson"), "utf8"),
      ).toContain('"legacy_repaired":1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("activates changed bytes at the same reported version and prunes only after verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-regression-"));
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
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-options-"));
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    const calls: string[] = [];
    const installed = new Set<string>();
    const manager: OfficialPluginManager = {
      list: async () => ({
        installed: [...installed].map((pluginId) => ({
          pluginId,
          installed: true,
          enabled: true,
        })),
        available: [],
      }),
      add: async (pluginId) => {
        calls.push(pluginId);
        installed.add(pluginId);
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
      expect(calls).toEqual([...CAPABILITY_REGISTRY.work.pluginIds, "sample"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("installer recovery and cleanup boundaries", () => {
  test("recovers only a validated stale lock and rejects traversal or symlink roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-boundary-"));
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
      await symlink(symlinkTarget, symlinkPath, process.platform === "win32" ? "junction" : "dir");
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
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-cleanup-"));
    const paths = { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") };
    try {
      const installed = await installHolyCodex({}, { paths });
      const resolvedPaths = resolveInstallerPaths({ paths });
      const lease = await acquireInstallLock(
        resolvedPaths,
        {
          ttlMs: 60_000,
          pid: process.pid,
          runId: "cleanup-lock-test",
          now: () => new Date("2026-08-21T00:00:00.000Z"),
        },
        async () => undefined,
      );
      await expect(
        (async () => {
          const maintenance = await import("./maintenance.ts");
          return await maintenance.cleanupHolyCodex("workspace", { paths }, { yes: true });
        })(),
      ).rejects.toMatchObject({ code: "lock_live" });
      await lease.release();
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
  test("creates and checks a typed workflow under the Codex workflow root", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-create-"));
    const codexHome = join(root, "codex");
    const marketplaceRoot = join(root, "marketplace");
    const sourcePath = join(root, "review.ts");
    const source = `
      import { createCodec, workflow } from "@holycodex/workflow";
      const text = createCodec("text", (value: unknown): string => String(value));
      const review = workflow.step({ id: "review", assignment: { input: text, output: text } });
      export default workflow.wait(review);
    `;
    await writeFile(sourcePath, source);
    const context = {
      cwd: root,
      trustGate: async () => true,
      installer: { paths: { codexHome, marketplaceRoot } },
      generatedWorkflowBoundary: generatedWorkflowTestBoundary(),
    } as const;
    try {
      const checked = await executeWorkflowCommand(
        parseArgv(["workflow", "check", sourcePath]),
        context,
      );
      expect(checked).toMatchObject({ valid: true, execution_mode: "native" });

      const created = await executeWorkflowCommand(
        parseArgv([
          "workflow",
          "create",
          sourcePath,
          "--session-id",
          "session-1",
          "--name",
          "review",
        ]),
        context,
      );
      expect(created).toMatchObject({ owner_session_id: "session-1", safe_name: "review" });
      if (!isJsonObject(created) || typeof created["source_path"] !== "string") {
        throw new Error("workflow create did not return a source path");
      }
      const generated = created["source_path"];
      expect(generated).toMatch(/\/workflows\/session-1\/review-[0-9a-f]{4}\.ts$/u);
      expect(await readFile(generated, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses task as the run objective and requires task for stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-task-"));
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
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-workflow-"));
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
    `${JSON.stringify({
      name: "holycodex",
      version: "0.1.0",
      description: "fixture",
      author: { name: "Fixture Author" },
      skills: "./skills",
      interface: {
        displayName: "Fixture",
        shortDescription: "Fixture plugin.",
        longDescription: "Fixture plugin for installer tests.",
        developerName: "Fixture Author",
        category: "Developer Tools",
        capabilities: ["Skills"],
        defaultPrompt: ["Use the fixture plugin."],
      },
    })}\n`,
  );
  await writeFile(join(root, "agents", "worker.md"), worker);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
