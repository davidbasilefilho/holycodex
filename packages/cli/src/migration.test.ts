// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { STATE_SCHEMA_EPOCH } from "@holycodex/core";
import {
  MIGRATION_RECORD_NAME,
  migrateLegacyState,
  publicManifestPath,
  readCanonicalVersion,
  resolveInstallerPaths,
} from "./index.ts";
import { readSavedWorkflow } from "./workflow-store.ts";

describe("legacy state migration", () => {
  test("uses the package manifest as the canonical version authority", async () => {
    const manifest = JSON.parse(await readFile(publicManifestPath, "utf8")) as {
      readonly version: string;
    };
    expect(await readCanonicalVersion()).toBe(manifest.version);
  });

  test("migrates selected state deterministically and reuses the completed result", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-migration-"));
    const paths = resolveInstallerPaths({
      paths: { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") },
    });
    const now = () => new Date("2026-01-01T00:00:00.000Z");
    try {
      await mkdir(paths.stateRoot, { recursive: true });
      await writeFile(
        join(paths.stateRoot, "legacy-state.json"),
        JSON.stringify({
          schema_epoch: "legacy-state-1",
          plan: "plus-high",
          tier: "Fast",
          autonomy: "autonomous",
          max_subagents: 2,
          computer_use: true,
          work: true,
          managed_config: { preserved: true },
          ownership_metadata: { owner: "legacy" },
          saved_workflows: [{ name: "demo", source: "return 1;" }],
          runs: [{ run_id: "run-1" }],
          continuations: [{ packet_id: "packet-1" }],
          refinements: [{ refinement_id: "refinement-1" }],
        }),
      );

      const first = await migrateLegacyState(paths, now);
      const second = await migrateLegacyState(paths, now);
      expect(first.status).toBe("migrated");
      expect(second.status).toBe("reused");
      const migrated = JSON.parse(
        await readFile(join(paths.stateRoot, "migrated-state.json"), "utf8"),
      ) as { selections: { plan: string; tier: string; autonomy: string; work: boolean } };
      expect(migrated.selections).toMatchObject({
        plan: "plus-high",
        tier: "Fast",
        autonomy: "autonomous",
        work: true,
      });
      await expect(readSavedWorkflow(paths.stateRoot, "user", "demo", root)).resolves.toMatchObject(
        {
          source: "return 1;",
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes an interrupted record and quarantines corrupt historical input", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-cli-migration-recovery-"));
    const paths = resolveInstallerPaths({
      paths: { codexHome: join(root, "home"), marketplaceRoot: join(root, "market") },
    });
    const now = () => new Date("2026-01-02T00:00:00.000Z");
    try {
      await mkdir(paths.stateRoot, { recursive: true });
      const legacyPath = join(paths.stateRoot, "legacy-state.json");
      await writeFile(legacyPath, JSON.stringify({ schema_epoch: "legacy-state-1", plan: "plus" }));
      await writeFile(
        join(paths.stateRoot, MIGRATION_RECORD_NAME),
        JSON.stringify({
          schema_epoch: STATE_SCHEMA_EPOCH,
          source_epoch: "legacy-state-1",
          source_digest: "a".repeat(64),
          status: "started",
          source_paths: [legacyPath],
          target_path: join(paths.stateRoot, "migrated-state.json"),
          updated_at: now().toISOString(),
        }),
      );
      const resumed = await migrateLegacyState(paths, now);
      expect(resumed.recovery).toBe("resumed");

      const corruptRoot = await mkdtemp(join(tmpdir(), "holycodex-cli-migration-corrupt-"));
      const corruptPaths = resolveInstallerPaths({
        paths: {
          codexHome: join(corruptRoot, "home"),
          marketplaceRoot: join(corruptRoot, "market"),
        },
      });
      try {
        await mkdir(corruptPaths.stateRoot, { recursive: true });
        await writeFile(join(corruptPaths.stateRoot, "legacy-state.json"), "{broken\n");
        const quarantined = await migrateLegacyState(corruptPaths, now);
        expect(quarantined.status).toBe("quarantined");
        expect(await readdir(join(corruptPaths.stateRoot, "quarantine"))).toHaveLength(1);
      } finally {
        await rm(corruptRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
