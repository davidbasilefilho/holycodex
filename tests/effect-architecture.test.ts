// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(workspaceRoot, "packages");

// These are the existing Promise-facing seams. New domain APIs must expose an
// Effect and add a deliberate leaf adapter instead of expanding this list.
const promiseAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/commands.ts",
  "packages/cli/src/generated-workflow-store.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/native-agents.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/refinement-store.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/workflow-store.ts",
  "packages/cli/src/workflow.ts",
  "packages/cli/src/types.ts",
  "packages/codex/src/assignment.ts",
  "packages/codex/src/client.ts",
  "packages/codex/src/effect-services.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/project.ts",
  "packages/codex/src/transport.ts",
  "packages/core/src/canonical.ts",
  "packages/git-bash/src/runner.ts",
  "packages/lsp-core/src/lsp/client-wrapper.ts",
  "packages/lsp-core/src/lsp/directory-diagnostics.ts",
  "packages/lsp-core/src/lsp/manager.ts",
  "packages/lsp-core/src/tools/diagnostics.ts",
  "packages/lsp-core/src/tools/install-decision.ts",
  "packages/lsp-core/src/tools/navigation.ts",
  "packages/lsp-core/src/tools/rename.ts",
  "packages/lsp-core/src/tools/runtime.ts",
  "packages/lsp-core/src/tools/setup.ts",
  "packages/lsp-core/src/tools/status.ts",
  "packages/lsp-core/src/tools/symbols.ts",
  "packages/lsp-daemon/src/daemon-client.ts",
  "packages/lsp-daemon/src/daemon-server.ts",
  "packages/lsp-daemon/src/ensure-daemon.ts",
  "packages/lsp-daemon/src/request-routing.ts",
  "packages/lsp-daemon/src/run-daemon.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/planning.ts",
  "packages/plugin/src/schemas.ts",
  "packages/plugin/src/source.ts",
  "packages/plugin/src/verification.ts",
  "packages/runtime-core/src/process.ts",
  "packages/safe-filesystem/src/client.ts",
  "packages/workflow-host/src/admission.ts",
  "packages/workflow-host/src/approval.ts",
  "packages/workflow-host/src/continuation.ts",
  "packages/workflow-host/src/creation.ts",
  "packages/workflow-host/src/execution.ts",
  "packages/workflow-host/src/identity.ts",
  "packages/workflow-host/src/lifecycle.ts",
  "packages/workflow-host/src/operation.ts",
  "packages/workflow-host/src/refinements.ts",
  "packages/workflow-host/src/replay.ts",
  "packages/workflow-host/src/types.ts",
  "packages/workflow-runtime/src/child.ts",
  "packages/workflow-runtime/src/index.ts",
  "packages/workflow-runtime/src/native-ir.ts",
  "packages/workflow-runtime/src/native-source.ts",
  "packages/workflow-runtime/src/runtime.ts",
  "packages/lsp-core/src/lsp/client.ts",
  "packages/lsp-core/src/lsp/json-rpc-connection.ts",
  "packages/lsp-core/src/lsp/process.ts",
  "packages/lsp-core/src/lsp/transport.ts",
  "packages/lsp-core/src/tools/types.ts",
  "packages/workflow-host/src/effect-runtime.ts",
  "packages/workflow-host/src/store.ts",
  "packages/workflow-runtime/src/compiler.ts",
]);

const ioAdapterAllowlist = new Set([
  "packages/cli/src/binary.ts",
  "packages/cli/src/generated-workflow-store.ts",
  "packages/cli/src/installer.ts",
  "packages/cli/src/lock.ts",
  "packages/cli/src/maintenance.ts",
  "packages/cli/src/manifest.ts",
  "packages/cli/src/migration.ts",
  "packages/cli/src/official-manager.ts",
  "packages/cli/src/paths.ts",
  "packages/cli/src/storage.ts",
  "packages/cli/src/workflow.ts",
  "packages/cli/src/index.ts",
  "packages/codex/src/executable.ts",
  "packages/codex/src/generated-artifact.ts",
  "packages/codex/src/official-plugins.ts",
  "packages/codex/src/project.ts",
  "packages/codex/src/transport.ts",
  "packages/git-bash/src/git-bash-resolver.ts",
  "packages/git-bash/src/runner.ts",
  "packages/lsp-core/src/index.ts",
  "packages/lsp-core/src/lsp/client-wrapper.ts",
  "packages/lsp-core/src/lsp/client.ts",
  "packages/lsp-core/src/lsp/config-loader.ts",
  "packages/lsp-core/src/lsp/connection.ts",
  "packages/lsp-core/src/lsp/directory-diagnostics.ts",
  "packages/lsp-core/src/lsp/infer-extension.ts",
  "packages/lsp-core/src/lsp/process.ts",
  "packages/lsp-core/src/lsp/server-install-state.ts",
  "packages/lsp-core/src/lsp/server-installation.ts",
  "packages/lsp-core/src/lsp/setup.ts",
  "packages/lsp-core/src/lsp/transport.ts",
  "packages/lsp-core/src/lsp/workspace-edit.ts",
  "packages/lsp-core/src/lsp/workspace-security.ts",
  "packages/lsp-core/src/request-context.ts",
  "packages/lsp-daemon/src/cli.ts",
  "packages/lsp-daemon/src/daemon-client.ts",
  "packages/lsp-daemon/src/daemon-server.ts",
  "packages/lsp-daemon/src/ensure-daemon.ts",
  "packages/lsp-daemon/src/lock.ts",
  "packages/lsp-daemon/src/paths.ts",
  "packages/lsp-daemon/src/run-daemon.ts",
  "packages/plugin/src/assembly.ts",
  "packages/plugin/src/source.ts",
  "packages/runtime-core/src/index.ts",
  "packages/runtime-core/src/process.ts",
  "packages/safe-filesystem/src/client.ts",
  "packages/workflow-host/src/execution.ts",
  "packages/workflow-host/src/store.ts",
  "packages/workflow-runtime/src/child.ts",
  "packages/workflow-runtime/src/index.ts",
  "packages/workflow-runtime/src/transform.ts",
]);

describe("Effect architecture boundaries", () => {
  test("keeps forbidden imports and unsafe any out of production source", async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (/effect\/internal/u.test(source)) violations.push(`${relativePath}: effect/internal`);
      if (/(?:\bas\s+any\b|:\s*any\b|<any>|[|&]\s*any\b)/u.test(source)) {
        violations.push(`${relativePath}: any`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("requires Promise APIs and direct platform I/O to stay in explicit adapters", async () => {
    const files = await sourceFiles(sourceRoot);
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (
        /export\s+(?:async\s+)?function[\s\S]*?Promise|export\s+interface[\s\S]*?Promise/u.test(
          source,
        )
      ) {
        if (!promiseAdapterAllowlist.has(relativePath))
          violations.push(`${relativePath}: Promise API`);
      }
      if (
        /from\s+["']node:(?:fs|fs\/promises|child_process|process|os|net|http|https)["']|\bprocess\./u.test(
          source,
        ) &&
        !ioAdapterAllowlist.has(relativePath)
      ) {
        violations.push(`${relativePath}: direct platform I/O`);
      }
    }
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const portablePath = path.replaceAll("\\", "/");
    if (entry.isDirectory() && entry.name !== "scripts" && entry.name !== "dist")
      result.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !portablePath.includes("/generated/")
    )
      result.push(path);
  }
  return result;
}
