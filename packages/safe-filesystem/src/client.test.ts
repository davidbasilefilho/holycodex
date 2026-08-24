// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import type { ManagedProcessResult } from "@holycodex/runtime-core";
import {
  createSafeWorkflowFilesystemBoundary,
  SafeFilesystemError,
  type SafeFilesystemRunner,
} from "./client.ts";
import { encodeRequest } from "./protocol.ts";

const digest = "a".repeat(64);
const rootIdentity = "p:1:2";

function result(stdout: string, changes: Partial<ManagedProcessResult> = {}): ManagedProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    ...changes,
  };
}

function injectedRunner(
  directoryEntries: readonly { readonly name: string; readonly kind: "file" | "directory" }[] = [
    { name: "workflow.ts", kind: "file" },
  ],
): {
  readonly calls: Array<{ readonly op: string; readonly root?: string; readonly target?: string }>;
  readonly runner: SafeFilesystemRunner;
} {
  const calls: Array<{ readonly op: string; readonly root?: string; readonly target?: string }> =
    [];
  return {
    calls,
    runner: async (input) => {
      const raw = JSON.parse(input.stdin ?? "{}") as Record<string, unknown>;
      const op = typeof raw["op"] === "string" ? raw["op"] : "";
      calls.push({
        op,
        ...(typeof raw["root"] === "string" ? { root: raw["root"] } : {}),
        ...(typeof raw["target"] === "string" ? { target: raw["target"] } : {}),
      });
      if (op === "version") {
        return result(
          JSON.stringify({
            version: 1,
            ok: true,
            op,
            helper_version: "safe-filesystem-helper-1",
            protocol_version: 1,
            source_sha256: digest,
          }) + "\n",
        );
      }
      if (op === "ensureRoot") {
        return result(
          JSON.stringify({ version: 1, ok: true, op, changed: true, root_identity: rootIdentity }) +
            "\n",
        );
      }
      if (op === "statDigest") {
        return result(
          JSON.stringify({
            version: 1,
            ok: true,
            op,
            exists: true,
            kind: raw["target"] === "session" ? "directory" : "file",
            size: 3,
            digest,
          }) + "\n",
        );
      }
      if (op === "readFile") {
        return result(
          JSON.stringify({
            version: 1,
            ok: true,
            op,
            size: 3,
            digest: "ce0f6c28b5869ff166714da5fe08554c70c731a335ff9702e38b00f81ad348c6",
            data: Buffer.from("tes").toString("base64"),
          }) + "\n",
        );
      }
      if (op === "listDirectory") {
        return result(
          JSON.stringify({
            version: 1,
            ok: true,
            op,
            entries: directoryEntries,
          }) + "\n",
        );
      }
      return result(JSON.stringify({ version: 1, ok: true, op, changed: true }) + "\n");
    },
  };
}

describe("safe filesystem protocol client", () => {
  test("validates root-relative strict components before invoking the helper", async () => {
    const injected = injectedRunner();
    const boundary = createSafeWorkflowFilesystemBoundary({ runner: injected.runner });
    await expect(
      boundary.readOwnedFile("/tmp/owned", "/tmp/owned/../escape.ts"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      boundary.readOwnedFile("/tmp/owned", "/tmp/owned/workflow:stream.ts"),
    ).rejects.toMatchObject({ code: "invalid_path" });
    expect(injected.calls).toHaveLength(0);
  });

  test("round-trips all generated-store operations through an injected runner", async () => {
    const injected = injectedRunner();
    const boundary = createSafeWorkflowFilesystemBoundary({ runner: injected.runner });
    const root = "/tmp/owned";
    await boundary.ensureDirectory(root, root);
    await boundary.ensureDirectory(root, `${root}/session`);
    await boundary.writeAtomicFile(
      root,
      `${root}/session/workflow.ts`,
      new TextEncoder().encode("tes"),
    );
    await expect(boundary.readOwnedFile(root, `${root}/session/workflow.ts`)).resolves.toEqual(
      new TextEncoder().encode("tes"),
    );
    await expect(boundary.readDirectory(root, `${root}/session`)).resolves.toEqual([
      { name: "workflow.ts", kind: "file" },
    ]);
    await boundary.removeOwnedDirectory(root, `${root}/session`);
    expect(injected.calls.map((call) => call.op)).toEqual([
      "version",
      "ensureRoot",
      "createSessionDir",
      "atomicWrite",
      "readFile",
      "listDirectory",
      "removeSessionTree",
    ]);
  });

  test("fails closed on a wrong helper version and bounded output", async () => {
    const wrongVersion = async (): Promise<ManagedProcessResult> =>
      result(
        JSON.stringify({
          version: 1,
          ok: true,
          op: "version",
          helper_version: "wrong-helper",
          protocol_version: 1,
          source_sha256: digest,
        }) + "\n",
      );
    const boundary = createSafeWorkflowFilesystemBoundary({ runner: wrongVersion });
    await expect(boundary.ensureDirectory("/tmp/owned", "/tmp/owned")).rejects.toMatchObject({
      code: "capability_unavailable",
    });

    const bounded = createSafeWorkflowFilesystemBoundary({
      runner: async () => result("", { outputTruncated: true }),
    });
    await expect(bounded.ensureDirectory("/tmp/owned", "/tmp/owned")).rejects.toBeInstanceOf(
      SafeFilesystemError,
    );
  });

  test("fails closed when the staged helper is absent", async () => {
    const helperPath = "/tmp/holycodex-safe-filesystem-missing/safe-filesystem";
    const boundary = createSafeWorkflowFilesystemBoundary({ platform: "posix", helperPath });
    await expect(boundary.ensureDirectory("/tmp/owned", "/tmp/owned")).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  });

  test("rejects case-folded directory collisions from the helper", async () => {
    const injected = injectedRunner([
      { name: "Workflow.ts", kind: "file" },
      { name: "workflow.ts", kind: "file" },
    ]);
    const boundary = createSafeWorkflowFilesystemBoundary({ runner: injected.runner });
    await expect(boundary.readDirectory("/tmp/owned", "/tmp/owned")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  test("keeps the protocol line length bounded", () => {
    expect(() =>
      encodeRequest({
        version: 1,
        op: "atomicWrite",
        root: "/tmp/owned",
        target: "workflow.ts",
        data: "A".repeat(8 * 1024 * 1024),
      }),
    ).toThrow();
  });
});
