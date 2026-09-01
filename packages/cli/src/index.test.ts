// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { PlanFirstExecutionGate, type JsonObject, type JsonValue } from "@holycodex/core";
import { CAPABILITY_REGISTRY } from "@holycodex/core";
import {
  doctorHolyCodex,
  executeWorkflowCommand,
  installHolyCodex,
  parseArgv,
  pathWithin,
  readCanonicalVersion,
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
        ["cleanup", "--scope", "workspace", "--no-tui", "--codex-home", join(root, "home")],
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
      const result = await runCli(["install", "--json", "--codex-home", join(root, "home")], {
        io: {
          stdoutIsTTY: false,
          stderrIsTTY: false,
          confirm: async () => {
            throw new Error("prompted");
          },
        },
      });
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

describe("native Codex installation", () => {
  test("delegates all plugin state and persists HolyCodex settings separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-options-"));
    const paths = { codexHome: join(root, "home") };
    const calls: string[] = [];
    const marketplaces: string[] = [];
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
      addMarketplace: async (source) => {
        marketplaces.push(source);
      },
      enableFeature: async (feature) => {
        expect(feature).toBe("default_mode_request_user_input");
      },
      featureEnabled: async (feature) => feature === "default_mode_request_user_input",
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
      expect(marketplaces).toEqual(["davidbasilefilho/holycodex", "davidbasilefilho/holycodex"]);
      expect(calls).toEqual([
        "holycodex@holycodex",
        ...CAPABILITY_REGISTRY.work.pluginIds,
        "sample",
      ]);
      expect(
        JSON.parse(await readFile(join(paths.codexHome, "holycodex", "active.json"), "utf8")),
      ).toMatchObject({ plan: "plus", optional_selections: { work: true } });
      const implementation = await readFile(
        join(paths.codexHome, "agents", "Worker.implementation.toml"),
        "utf8",
      );
      const mechanical = await readFile(
        join(paths.codexHome, "agents", "Worker.mechanical.toml"),
        "utf8",
      );
      expect(implementation).toContain('name = "Worker.implementation"');
      expect(implementation).toContain("Implement and verify the bounded behavior seam.");
      expect(mechanical).toContain('name = "Worker.mechanical"');
      expect(mechanical).toContain("Worker shared policy:");
      expect((await doctorHolyCodex({ paths, officialPluginManager: manager })).healthy).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workflow dispatch", () => {
  test("plan-first blocks workflow mutation before service creation or dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-plan-first-"));
    let serviceCalls = 0;
    try {
      const gate = new PlanFirstExecutionGate("planning");
      await expect(
        executeWorkflowCommand(parseArgv(["workflow", "run", join(root, "workflow.ts")]), {
          planFirstGate: gate,
          workflowService: {
            create: async () => {
              serviceCalls += 1;
              throw new Error("dispatch must remain locked");
            },
          },
        }),
      ).rejects.toMatchObject({ code: "plan_first_locked" });
      expect(serviceCalls).toBe(0);
      expect(await readdir(root)).toEqual([]);
      const install = await runCli(
        ["install", "--yes", "--json", "--codex-home", join(root, "codex-home")],
        { planFirstGate: gate },
      );
      expect(install.exitCode).toBe(2);
      expect(install.envelope).toMatchObject({
        ok: false,
        error: { code: "capability_denied", details: { reason: "plan_first_locked" } },
      });
      gate.authorizeContinuation();
      expect(gate.phase).toBe("implementation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates and checks a typed workflow under the Codex workflow root", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-create-"));
    const codexHome = join(root, "codex");
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
      installer: { paths: { codexHome } },
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
      expect(generated.replaceAll("\\", "/")).toMatch(
        /\/workflows\/session-1\/review-[0-9a-f]{4}\.ts$/u,
      );
      expect(await readFile(generated, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("materializes and immediately runs one stdin source under its declared name", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-task-"));
    const source = join(root, "workflow.ts");
    const workflowSource = `
      import { createCodec, workflow } from "@holycodex/workflow";
      const text = createCodec("text", (value: unknown): string => String(value));
      const step = workflow.step({ id: "review", assignment: { input: text, output: text } });
      export default { name: "review", workflow: workflow.wait(step) };
    `;
    await writeFile(source, workflowSource);
    let created:
      | {
          readonly objective: string;
          readonly source: string;
          readonly args: unknown;
          readonly sourcePath?: string;
        }
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
      expect(created).toMatchObject({
        objective: "workflow:workflow",
        source: workflowSource,
        args: { n: 1 },
      });

      await expect(
        executeWorkflowCommand(parseArgv(["workflow", "run", "-", "--json"]), {
          installer: {
            paths: { codexHome: join(root, "codex") },
          },
          generatedWorkflowBoundary: generatedWorkflowTestBoundary(),
          io: {
            stdin: (async function* () {
              yield workflowSource;
            })(),
          },
          workflowService: service,
        }),
      ).rejects.toThrow("create sentinel");
      expect(created).toMatchObject({
        objective: "workflow:review",
        source: workflowSource,
        args: {},
      });
      expect(created?.sourcePath?.replaceAll("\\", "/")).toMatch(
        /\/workflows\/run-[a-f0-9]{24}\/review-[a-f0-9]{4}\.ts$/u,
      );
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

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
