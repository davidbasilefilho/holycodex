// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionWorkflows,
  materializeSessionWorkflow,
  verifySessionWorkflow,
} from "./session-workflow-store.ts";

async function withStateRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "holycodex-workflow-store-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("session workflow storage", () => {
  test("uses stable content-addressed TypeScript paths for identical workflows", async () => {
    await withStateRoot(async (root) => {
      const input = {
        sessionId: "session-1",
        name: "review-changes",
        source: "export default workflow.wait({});\n",
      } as const;
      const first = await materializeSessionWorkflow(root, input);
      const second = await materializeSessionWorkflow(root, input);
      expect(second).toEqual(first);
      expect(first.path).toMatch(/workflows[/\\]session-1[/\\]review-changes-[0-9a-f]{12}\.ts$/u);
      expect(await readFile(first.path, "utf8")).toBe(input.source);
      expect(await verifySessionWorkflow(root, first)).toBe(input.source);
    });
  });

  test("isolates equal workflow names by session", async () => {
    await withStateRoot(async (root) => {
      const source = "export default workflow.wait({});\n";
      const first = await materializeSessionWorkflow(root, {
        sessionId: "session-a",
        name: "plan",
        source,
      });
      const second = await materializeSessionWorkflow(root, {
        sessionId: "session-b",
        name: "plan",
        source,
      });
      expect(first.path).not.toBe(second.path);
      expect(first.digest).not.toBe(second.digest);
    });
  });

  test("fails closed after persisted workflow tampering", async () => {
    await withStateRoot(async (root) => {
      const identity = await materializeSessionWorkflow(root, {
        sessionId: "session-tamper",
        name: "implement",
        source: "export default workflow.wait({});\n",
      });
      await writeFile(identity.path, "export default 'tampered';\n", "utf8");
      await expect(verifySessionWorkflow(root, identity)).rejects.toMatchObject({
        code: "workflow_tampered",
      });
    });
  });

  test("rejects unsafe names and removes explicitly cleaned session files", async () => {
    await withStateRoot(async (root) => {
      await expect(
        materializeSessionWorkflow(root, {
          sessionId: "../escape",
          name: "safe",
          source: "export default workflow.wait({});\n",
        }),
      ).rejects.toMatchObject({ code: "workflow_invalid" });
      const identity = await materializeSessionWorkflow(root, {
        sessionId: "session-clean",
        name: "cleanup",
        source: "export default workflow.wait({});\n",
      });
      await cleanupSessionWorkflows(root, identity.sessionId);
      await expect(readFile(identity.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
