// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { OfficialPluginIdSchema, readTomlPath, writeTomlPath } from "@holycodex/codex";
import { EffortSchema, NATIVE_AGENT_TYPES } from "@holycodex/core";
import * as Schema from "effect/Schema";

import {
  installHolyCodex,
  removeHolyCodex,
  resolveInstallerPaths,
  type InstallerOptions,
  type InstallerRuntime,
  type OfficialPluginManager,
} from "./index.ts";
import { desiredRootConfig, parseConfig, serializeConfig } from "./installer.ts";
import { projectNativeAgents, projectRootAgent } from "./native-agents.ts";

const NonEmptyStringSchema = Schema.String.check(Schema.isNonEmpty());
// This strict installed-config subset follows the current Codex schema and configuration refs;
// use the permission-profile reference for fields not represented by the generated schema.
// https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json
// https://developers.openai.com/codex/config-reference/
// https://developers.openai.com/codex/permissions/
const AgentRegistrationSchema = Schema.Struct({ config_file: NonEmptyStringSchema });
const FeatureConfigSchema = Schema.Struct({
  multi_agent: Schema.Boolean,
  default_mode_request_user_input: Schema.Boolean,
  multi_agent_v2: Schema.Boolean,
  agent_message_board: Schema.Boolean,
  context_management: Schema.Struct({ experimental_mode: Schema.Boolean }),
});
const PermissionProfileSchema = Schema.Struct({
  extends: Schema.Literals([":workspace"]),
  network: Schema.Struct({ enabled: Schema.Boolean }),
});
const InstalledCodexConfigSchema = Schema.Struct({
  model: NonEmptyStringSchema,
  model_reasoning_effort: EffortSchema,
  service_tier: Schema.Literals(["default", "fast", "fast-all"]),
  web_search: Schema.Literals(["live"]),
  approval_policy: Schema.Literals(["on-request"]),
  approvals_reviewer: Schema.Literals(["auto_review"]),
  model_verbosity: Schema.Literals(["low"]),
  developer_instructions: NonEmptyStringSchema,
  suppress_unstable_features_warning: Schema.Boolean,
  default_permissions: Schema.Literals(["holycodex"]),
  plugins: Schema.Record(OfficialPluginIdSchema, Schema.Struct({ enabled: Schema.Boolean })),
  marketplaces: Schema.Struct({
    holycodex: Schema.Struct({
      source_type: Schema.Literals(["git"]),
      source: NonEmptyStringSchema,
    }),
  }),
  agents: Schema.StructWithRest(
    Schema.Struct({
      max_concurrent_threads_per_session: Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThan(0),
      ),
    }),
    [Schema.Record(Schema.Literals(NATIVE_AGENT_TYPES), AgentRegistrationSchema)],
  ),
  permissions: Schema.Struct({ holycodex: PermissionProfileSchema }),
  features: FeatureConfigSchema,
});
const InstalledNativeAgentConfigSchema = Schema.Struct({
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  model_reasoning_effort: EffortSchema,
  service_tier: Schema.Literals(["default", "fast"]),
  model_reasoning_summary: Schema.Literals(["none"]),
  model_verbosity: Schema.Literals(["low"]),
  developer_instructions: NonEmptyStringSchema,
  agents: Schema.Struct({
    enabled: Schema.Literals([false]),
    interrupt_message: Schema.Literals([false]),
  }),
  features: Schema.Struct({
    multi_agent: Schema.Literals([false]),
    multi_agent_v2: Schema.Literals([false]),
    agent_message_board: Schema.Literals([false]),
    context_management: Schema.Struct({ experimental_mode: Schema.Literals([true]) }),
  }),
});

function validateInstalledCodexConfig(config: unknown): void {
  Schema.decodeUnknownSync(InstalledCodexConfigSchema, { onExcessProperty: "error" })(config);
}

function validateInstalledNativeAgentConfig(config: unknown): void {
  Schema.decodeUnknownSync(InstalledNativeAgentConfigSchema, { onExcessProperty: "error" })(config);
}

const CODEX_EXECUTABLE = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));

describe("isolated HolyCodex permission installation", () => {
  test("installs a schema-valid config and initial HolyCodex profile in a temporary CODEX_HOME", async () => {
    const temporaryRoot = await mkdtemp(join(process.cwd(), ".tmp-holycodex-codex-permissions-"));
    const codexHome = join(temporaryRoot, "codex-home");
    const paths = resolveInstallerPaths({ paths: { codexHome } });
    const pluginManager = createPluginManager();
    try {
      await mkdir(codexHome, { recursive: true });
      for (const profile of ["low", "default", "high"] as const) {
        await installHolyCodex(
          { profile, optional: { computer_use: false } },
          installerOptions(codexHome, pluginManager),
          { CODEX_HOME: codexHome, PATH: process.env["PATH"] ?? "" },
        );

        const configText = await readFile(paths.configFile, "utf8");
        const config = parseConfig(configText, paths.configFile);
        validateInstalledCodexConfig(config);
        const root = projectRootAgent(profile);
        expect(readTomlPath(config, "default_permissions")).toBe("holycodex");
        expect(readTomlPath(config, "permissions.holycodex.extends")).toBe(":workspace");
        expect(readTomlPath(config, "permissions.holycodex.network.enabled")).toBe(true);
        expect(readTomlPath(config, "approval_policy")).toBe("on-request");
        expect(readTomlPath(config, "approvals_reviewer")).toBe("auto_review");
        expect(readTomlPath(config, "web_search")).toBe("live");
        expect(readTomlPath(config, "sandbox_mode")).toBeUndefined();
        expect(readTomlPath(config, "sandbox_workspace_write.network_access")).toBeUndefined();
        expect(readTomlPath(config, "model")).toBe(root.model);
        expect(readTomlPath(config, "model_reasoning_effort")).toBe(root.effort);
        expect(root.effort).not.toBe("max");
        expect(
          desiredRootConfig(profile, "standard")["agents.max_concurrent_threads_per_session"],
        ).toBeGreaterThan(0);
        expect(() =>
          validateInstalledCodexConfig({ ...config, unsupported_config_key: true }),
        ).toThrow();
        expect(() =>
          validateInstalledCodexConfig(
            writeTomlPath(config, "permissions.holycodex.network.unsupported", true),
          ),
        ).toThrow();

        const agents = projectNativeAgents(profile);
        const registered = readTomlPath(config, "agents");
        expect(typeof registered).toBe("object");
        const registrationTable = registered as Record<string, unknown>;
        expect(
          Object.keys(registrationTable)
            .filter((name) => name !== "max_concurrent_threads_per_session")
            .sort(),
        ).toEqual(agents.map((agent) => agent.name).sort());
        for (const agent of agents) {
          const relativePath = readTomlPath(
            config,
            `agents.${JSON.stringify(agent.name)}.config_file`,
          );
          if (typeof relativePath !== "string") throw new Error("Missing agent registration.");
          expect(relativePath).toMatch(/^holycodex\/agents\/[a-f0-9]{20}\//u);
          expect(relativePath.endsWith(`/${agent.name}.toml`)).toBe(true);
          const rolePath = join(codexHome, relativePath);
          const role = parseConfig(await readFile(rolePath, "utf8"), rolePath);
          validateInstalledNativeAgentConfig(role);
          expect(role["name"]).toBe(agent.name);
          expect(role["model"]).toBe(agent.model);
          expect(role["model_reasoning_effort"]).toBe(agent.effort);
          expect(agent.effort).not.toBe("max");
          expect(role["sandbox_mode"]).toBeUndefined();
          expect(role["approval_policy"]).toBeUndefined();
          expect(role["approvals_reviewer"]).toBeUndefined();
          expect(role["web_search"]).toBeUndefined();
          expect(readTomlPath(role, "sandbox_workspace_write.network_access")).toBeUndefined();
        }
        expect(agents.map((agent) => agent.name)).toContain("Reviewer.audit");
        expect(agents.map((agent) => agent.name)).toContain("Reviewer.testing");
        expect(agents.map((agent) => agent.name)).toContain("Reviewer.security");
        const expectedReviewerEfforts = {
          low: {
            "Reviewer.audit": "medium",
            "Reviewer.testing": "medium",
            "Reviewer.security": "high",
          },
          default: {
            "Reviewer.audit": "high",
            "Reviewer.testing": "high",
            "Reviewer.security": "high",
          },
          high: {
            "Reviewer.audit": "high",
            "Reviewer.testing": "high",
            "Reviewer.security": "high",
          },
        } as const;
        for (const name of ["Reviewer.audit", "Reviewer.testing", "Reviewer.security"] as const) {
          const reviewer = agents.find((agent) => agent.name === name);
          expect(reviewer).toMatchObject({
            model: "gpt-6-luna",
            effort: expectedReviewerEfforts[profile][name],
            permissions: {
              network: true,
              filesystem: "workspace-write",
              sourceMutation: true,
            },
          });
        }
      }

      // `doctor --json` only diagnoses local configuration; do not use `codex exec`, start a
      // session, or pass environment credentials that could enable a model request.
      const doctorEnvironment: Record<string, string> = {
        CODEX_HOME: codexHome,
        HOME: temporaryRoot,
        USERPROFILE: temporaryRoot,
        PATH: process.env["PATH"] ?? "",
        NO_COLOR: "1",
        TERM: "dumb",
      };
      for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
        const value = process.env[key];
        if (value !== undefined) doctorEnvironment[key] = value;
      }
      const doctor = Bun.spawn([process.execPath, CODEX_EXECUTABLE, "doctor", "--json"], {
        env: doctorEnvironment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [doctorStdout, doctorStderr, doctorExitCode] = await Promise.all([
        new Response(doctor.stdout).text(),
        new Response(doctor.stderr).text(),
        doctor.exited,
      ]);
      const doctorReport: unknown = JSON.parse(doctorStdout);
      const configCheck =
        typeof doctorReport === "object" && doctorReport !== null && "checks" in doctorReport
          ? (doctorReport.checks as Record<string, unknown>)["config.load"]
          : undefined;
      if (
        typeof configCheck !== "object" ||
        configCheck === null ||
        !("status" in configCheck) ||
        configCheck.status !== "ok"
      ) {
        throw new Error(
          `Codex config-load diagnostic failed (doctor exit ${doctorExitCode}): ${doctorStderr || doctorStdout}`,
        );
      }
      expect(configCheck).toMatchObject({ id: "config.load", status: "ok" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("removal clears only HolyCodex's selected default and preserves another choice", async () => {
    const temporaryRoot = await mkdtemp(join(process.cwd(), ".tmp-holycodex-permission-remove-"));
    const selectedHome = join(temporaryRoot, "selected-home");
    const alternateHome = join(temporaryRoot, "alternate-home");
    try {
      for (const codexHome of [selectedHome, alternateHome]) {
        await mkdir(codexHome, { recursive: true });
        await installHolyCodex({ optional: { computer_use: false } }, installerOptions(codexHome), {
          CODEX_HOME: codexHome,
          PATH: process.env["PATH"] ?? "",
        });
      }

      const alternatePaths = resolveInstallerPaths({ paths: { codexHome: alternateHome } });
      const alternateConfig = parseConfig(await readFile(alternatePaths.configFile, "utf8"));
      await writeFile(
        alternatePaths.configFile,
        serializeConfig(writeTomlPath(alternateConfig, "default_permissions", ":read-only")),
      );

      await removeHolyCodex(
        { paths: { codexHome: selectedHome }, officialPluginManager: createPluginManager() },
        { CODEX_HOME: selectedHome },
      );
      await removeHolyCodex(
        { paths: { codexHome: alternateHome }, officialPluginManager: createPluginManager() },
        { CODEX_HOME: alternateHome },
      );

      const selectedPaths = resolveInstallerPaths({ paths: { codexHome: selectedHome } });
      expect(
        readTomlPath(
          parseConfig(await readFile(selectedPaths.configFile, "utf8")),
          "default_permissions",
        ),
      ).toBeUndefined();
      expect(
        readTomlPath(
          parseConfig(await readFile(alternatePaths.configFile, "utf8")),
          "default_permissions",
        ),
      ).toBe(":read-only");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

function installerOptions(
  codexHome: string,
  officialPluginManager: OfficialPluginManager = createPluginManager(),
): InstallerOptions {
  return {
    paths: { codexHome },
    officialPluginManager,
    runtime: createInstallerRuntime(codexHome),
  };
}

function createPluginManager(): OfficialPluginManager {
  const installed = new Set<string>();
  return {
    list: async () => ({
      installed: [...installed].map((pluginId) => ({ pluginId, installed: true, enabled: true })),
      available: [],
    }),
    addMarketplace: async () => undefined,
    add: async (pluginId) => {
      installed.add(pluginId);
    },
    remove: async (pluginId) => {
      installed.delete(pluginId);
    },
    status: async (pluginIds) =>
      Object.fromEntries(
        pluginIds.map(
          (pluginId) => [pluginId, installed.has(pluginId) ? "installed" : "missing"] as const,
        ),
      ),
  };
}

function createInstallerRuntime(codexHome: string): InstallerRuntime {
  let toolingInstalled = false;
  const binRoot = join(codexHome, "test-global-bin");
  const projectRoot = join(codexHome, "test-global-install");
  const packageRoot = join(projectRoot, "node_modules", "ctx7");
  const packageExecutable = join(packageRoot, "dist", "index.js");
  const shim = join(binRoot, process.platform === "win32" ? "ctx7.cmd" : "ctx7");
  const allowedPaths = [binRoot, projectRoot, packageRoot, packageExecutable, shim].map((path) =>
    path.replaceAll("\\", "/"),
  );
  return {
    platform:
      process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    environment: { PATH: binRoot },
    processPath: "bun",
    files: {
      access: async (path) => {
        const normalizedPath = path.replaceAll("\\", "/");
        if (
          !allowedPaths.includes(normalizedPath) ||
          (!toolingInstalled && ![binRoot, projectRoot].includes(normalizedPath))
        ) {
          throw new Error("missing");
        }
      },
      readText: async (path) => {
        const packageJson = `${packageRoot.replaceAll("\\", "/")}/package.json`;
        if (!toolingInstalled || path.replaceAll("\\", "/") !== packageJson) {
          throw new Error("missing");
        }
        return JSON.stringify({ version: "2.0.0", bin: { ctx7: "dist/index.js" } });
      },
      realpath: async (path) => path,
    },
    run: async (executable, args) => {
      if (executable === "bun" && args.join(" ") === "pm bin -g") {
        return { exitCode: 0, stdout: `${binRoot}\n`, stderr: "" };
      }
      if (executable === "bun" && args.join(" ") === "pm view ctx7 version") {
        return { exitCode: 0, stdout: "2.0.0\n", stderr: "" };
      }
      if (executable === "bun" && args[0] === "add" && args.includes("ctx7@latest")) {
        toolingInstalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === "bun" && args[0] === "remove" && args.at(-1) === "ctx7") {
        toolingInstalled = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (executable === shim && args[0] === "--version" && toolingInstalled) {
        return { exitCode: 0, stdout: "ctx7 2.0.0\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "missing" };
    },
  };
}
