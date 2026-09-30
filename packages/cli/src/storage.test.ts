// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readActiveInstallRecord, readInstallTransaction } from "./installer.ts";
import { resolveInstallerPaths } from "./paths.ts";
import { JsonObjectSchema } from "./schema.ts";
import {
  decodeStateText,
  migrateValidatedState,
  optionalStateFile,
  writeAtomicState,
} from "./storage.ts";

test("installer TOML preserves nullable snapshots and empty string values", async () => {
  const root = await mkdtemp(join(tmpdir(), "holycodex-state-"));
  try {
    const path = join(root, "active.toml");
    const record = { snapshot: { value: null, empty: "" }, entries: [{ value: null }, ""] };
    await writeAtomicState(path, record);
    const source = await readFile(path, "utf8");
    expect(Bun.TOML.parse(source)).toMatchObject({ format_version: 1 });
    expect(decodeStateText(source, JsonObjectSchema)).toEqual(record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy installer JSON migrates to canonical TOML and removes only its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "holycodex-state-migration-"));
  try {
    const path = join(root, "active.toml");
    await writeFile(join(root, "active.json"), '{"install_id":"previous","snapshot":null}');
    await writeFile(join(root, "notes.txt"), "keep");
    expect(await optionalStateFile(path, JsonObjectSchema)).toEqual({
      install_id: "previous",
      snapshot: null,
    });
    await migrateValidatedState(path, { install_id: "previous", snapshot: null });
    await expect(readFile(join(root, "active.json"))).rejects.toThrow();
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("keep");
    expect(await optionalStateFile(path, JsonObjectSchema)).toEqual({
      install_id: "previous",
      snapshot: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid legacy installation and transaction records retain their original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "holycodex-invalid-state-"));
  try {
    const paths = resolveInstallerPaths({ paths: { codexHome: root } });
    for (const [path, read] of [
      [paths.activeRecord, () => readActiveInstallRecord(paths)],
      [paths.preparingRecord, () => readInstallTransaction(paths.preparingRecord)],
    ] as const) {
      const legacyPath = path.replace(/\.toml$/u, ".json");
      await writeAtomicState(join(paths.stateRoot, "placeholder.toml"), {});
      const source = '{"install_id":"invalid","snapshot":null}\n';
      await writeFile(legacyPath, source);
      await expect(read()).rejects.toMatchObject({ code: "state_corrupt" });
      expect(await readFile(legacyPath, "utf8")).toBe(source);
      await expect(readFile(path)).rejects.toThrow();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
