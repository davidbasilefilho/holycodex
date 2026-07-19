import { describe, expect, it } from "vitest";

import {
  codexSlimEditInvocation,
  detectPackageRunner,
  installCodexSlimEdit,
} from "../packages/cli/src/package-runner.ts";

describe("package runner selection", () => {
  it("follows the package runner that invoked HolyCodex", () => {
    expect(detectPackageRunner({ npm_execpath: "/opt/bun/bin/bun" })).toBe("bun");
    expect(detectPackageRunner({ npm_config_user_agent: "bun/1.3.14 npm/? node/v24" })).toBe("bun");
    expect(detectPackageRunner({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" })).toBe(
      "npm",
    );
    expect(
      detectPackageRunner({ npm_execpath: "/home/ubuntu/.nvm/versions/node/npm-cli.js" }),
    ).toBe("npm");
    expect(detectPackageRunner({})).toBe("npm");
  });

  it("uses runner-specific preinstall and MCP invocations", () => {
    expect(
      codexSlimEditInvocation({
        packageRunner: "bun",
        platform: "linux",
        packageVersion: "0.7.4",
        includeVersion: true,
      }),
    ).toEqual({
      command: "bunx",
      args: ["codexslimedit@latest", "--version"],
    });
    expect(
      codexSlimEditInvocation({
        packageRunner: "npm",
        platform: "linux",
        packageVersion: "0.7.4",
        includeVersion: true,
      }),
    ).toEqual({
      command: "npx",
      args: ["--yes", "codexslimedit@latest", "--version"],
    });
    expect(
      codexSlimEditInvocation({
        packageRunner: "npm",
        platform: "win32",
        packageVersion: "0.7.4-dev.1",
      }),
    ).toEqual({
      command: "npx.cmd",
      args: ["--yes", "codexslimedit@dev"],
    });
    expect(
      codexSlimEditInvocation({
        packageRunner: "npm",
        platform: "linux",
        packageVersion: "0.7.4-dev.1",
      }),
    ).toEqual({
      command: "npx",
      args: ["--yes", "codexslimedit@dev"],
    });
  });

  it("allows subprocess CLI tests to skip external package resolution", async () => {
    await expect(
      installCodexSlimEdit(
        { packageRunner: "npm", packageVersion: "0.7.4", platform: "linux" },
        {
          NODE_ENV: "test",
          HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION: "1",
        },
      ),
    ).resolves.toBeUndefined();
  });
});
