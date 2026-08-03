import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENTS, MODEL_ROUTING_PLANS, VERSION } from "../packages/cli/src/catalog";
import { installConfig } from "../packages/cli/src/config";
import { doctor, type DoctorRuntime } from "../packages/cli/src/doctor";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "holycodex-doctor-"));
  fixtures.push(home);
  const plugin = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  await mkdir(join(plugin, ".."), { recursive: true });
  await cp(join(import.meta.dirname, "..", "packages", "plugin", "plugin"), plugin, {
    recursive: true,
  });
  const agents = join(home, "holycodex", "agents");
  await mkdir(agents, { recursive: true });
  await Promise.all(
    AGENTS.map((agent) => {
      const route = MODEL_ROUTING_PLANS.plus.agents[agent];
      return writeFile(
        join(agents, `${agent}.toml`),
        `model = "${route.model}"\nmodel_reasoning_effort = "${route.reasoningEffort}"\n`,
      );
    }),
  );
  await writeFile(join(home, "config.toml"), installConfig("", "default", "win32"));
  return home;
}

describe("doctor", () => {
  it("validates the installed CLI-backed integrations without executing Context7", async () => {
    const home = await fixture();
    const commands: string[] = [];
    const runtime: DoctorRuntime = {
      platform: "win32",
      executable: (name) => name === "nubx",
      command: async (name) => {
        commands.push(name);
        return { ok: true, output: "ready" };
      },
      gitBash: () => ({ found: true, path: "bash.exe", source: "env", checkedPaths: [] }),
    };

    const result = await doctor(home, runtime);

    expect(result.healthy).toBe(true);
    expect(result.checks.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "live-web-search",
        "context-visible",
        "context7-cli-ready",
        "lsp-cli-ready",
        "git-bash-launcher-ready",
      ]),
    );
    expect(commands).toEqual([process.execPath]);
  });

  it("reports an unavailable Context7 runner as unhealthy", async () => {
    const home = await fixture();
    const result = await doctor(home, {
      platform: "linux",
      executable: () => false,
      command: async () => ({ ok: true, output: "ready" }),
      gitBash: () => ({ found: true, path: null, source: "not-required", checkedPaths: [] }),
    });

    expect(result.healthy).toBe(false);
    expect(result.checks.map((item) => item.code)).toContain("context7-runner-missing");
  });
});
