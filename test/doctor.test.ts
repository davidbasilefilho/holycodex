import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor, type DoctorRuntime } from "../packages/cli/src/doctor";
import { installConfig, type AutonomyMode } from "../packages/cli/src/config";
import { effectiveMcpServers, VERSION } from "../packages/cli/src/catalog";

const root = join(import.meta.dirname, "..");
const gitBashReady = { found: true, path: null, source: "not-required", checkedPaths: [] } as const;

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
  return {
    platform: "win32",
    command: async (name) => ({
      ok: true,
      output: name === "codex" ? "codex-cli 1.2.3" : "1.3.14",
    }),
    context7: async () => ({ ok: true, packageFailure: false, detail: "" }),
    gitBash: () => gitBashReady,
    ...overrides,
  };
}

async function fixture(mode: AutonomyMode = "default"): Promise<{ home: string; plugin: string }> {
  const home = await mkdtemp(join(tmpdir(), "holycodex-doctor-"));
  const plugin = join(home, "plugins", "cache", "holycodex", "holycodex", VERSION);
  await mkdir(join(plugin, ".."), { recursive: true });
  await cp(join(root, "packages", "plugin", "plugin"), plugin, { recursive: true });
  await writeFile(join(home, "config.toml"), installConfig("", mode, "win32"));
  return { home, plugin };
}

function codes(result: Awaited<ReturnType<typeof doctor>>): string[] {
  return result.checks.map((item) => item.code);
}

describe("HolyCodex doctor", () => {
  it("reports comprehensive healthy state", async () => {
    const { home } = await fixture();
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(true);
    expect(result.autonomy).toBe("safe-workspace");
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "package-ready",
        "required-mcp-ready",
        "local-context7-config",
        "bun-ready",
        "bunx-ready",
        "context7-healthy",
        "git-bash-ready",
        "safe-workspace-ready",
        "user-input-ready",
        "context-visible-support-unverified",
        "codex-version",
      ]),
    );
  });

  it("warns without failing for explicitly dangerous autonomy", async () => {
    const { home } = await fixture("dangerous");
    const result = await doctor(home, runtime());
    expect(result.healthy).toBe(true);
    expect(result.autonomy).toBe("dangerous");
    expect(codes(result)).toContain("dangerous-autonomy");
  });

  it("distinguishes missing Bun and bunx", async () => {
    const { home } = await fixture();
    const result = await doctor(
      home,
      runtime({ command: async (name) => ({ ok: name === "codex", output: "" }) }),
    );
    expect(result.healthy).toBe(false);
    expect(codes(result)).toEqual(expect.arrayContaining(["missing-bun", "missing-bunx"]));
    expect(codes(result)).not.toContain("context7-healthy");
  });

  it("distinguishes malformed and obsolete Context7 configuration", async () => {
    const malformed = await fixture();
    await writeFile(join(malformed.plugin, ".mcp.json"), "{");
    expect(codes(await doctor(malformed.home, runtime()))).toContain("malformed-mcp-config");

    const obsolete = await fixture();
    const mcpPath = join(obsolete.plugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8")) as {
      mcpServers: { context7: Record<string, unknown> };
    };
    mcp.mcpServers.context7 = {
      command: "bunx",
      args: ["@upstash/context7-mcp"],
      headers: { Authorization: "redacted" },
    };
    await writeFile(mcpPath, JSON.stringify(mcp));
    expect(codes(await doctor(obsolete.home, runtime()))).toContain("obsolete-context7-auth");
  });

  it("distinguishes package resolution from startup failure", async () => {
    const first = await fixture();
    const packageFailure = runtime({
      context7: async () => ({ ok: false, packageFailure: true, detail: "package not found" }),
    });
    expect(codes(await doctor(first.home, packageFailure))).toContain(
      "context7-package-resolution-failed",
    );

    const second = await fixture();
    const startupFailure = runtime({
      context7: async () => ({ ok: false, packageFailure: false, detail: "handshake timeout" }),
    });
    expect(codes(await doctor(second.home, startupFailure))).toContain("context7-startup-failed");
  });

  it("reports package, Git Bash, config, feature, and visibility failures", async () => {
    const { home, plugin } = await fixture();
    await rm(join(plugin, "runtime", "lsp.js"));
    await writeFile(
      join(home, "config.toml"),
      'approval_policy = "never"\nsandbox_mode = "workspace-write"\n',
    );
    const gitBashMissing = runtime({
      gitBash: () => ({ found: false, checkedPaths: [], installHint: "Install Git Bash." }),
    });
    const result = await doctor(home, gitBashMissing);
    expect(result.healthy).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "package-incomplete",
        "missing-git-bash",
        "invalid-autonomy-config",
        "user-input-disabled",
        "context-hidden",
      ]),
    );
  });

  it("treats Git Bash as not applicable off Windows", async () => {
    const { home, plugin } = await fixture();
    await rm(join(plugin, "runtime", "git-bash.js"));
    await rm(join(plugin, "runtime", "git-bash-resolver.js"));
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({ mcpServers: effectiveMcpServers("linux") }),
    );
    const result = await doctor(
      home,
      runtime({
        platform: "linux",
        gitBash: () => ({ found: false, checkedPaths: [], installHint: "irrelevant" }),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(codes(result)).toContain("git-bash-not-applicable");
    expect(codes(result)).not.toContain("missing-required-mcp");
    expect(codes(result)).not.toContain("missing-git-bash");
  });
});
