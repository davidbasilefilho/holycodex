#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonFiles = [
  "package.json",
  "plugin/.codex-plugin/plugin.json",
  "packages/git-bash-mcp/package.json",
  "packages/lsp-core/package.json",
  "packages/lsp-daemon/package.json",
  "packages/mcp-stdio-core/package.json",
];
const textFiles = [
  "src/cli.ts",
  "src/install.ts",
  "test/cli.test.ts",
  "packages/git-bash-mcp/src/mcp.ts",
  "packages/git-bash-mcp/src/mcp-protocol-pin.test.ts",
  "packages/lsp-core/src/mcp.ts",
  "packages/lsp-core/src/mcp-protocol-pin.test.ts",
  "packages/lsp-daemon/test/proxy-protocol-pin.test.ts",
];

export function nextZeroVersion(current, change) {
  const match = /^0\.(\d+)\.(\d+)$/.exec(current);
  if (match === null) throw new Error(`Expected zerover version, received: ${current}`);
  const minor = Number(match[1]);
  const patch = Number(match[2]);
  if (change === "patch") return `0.${minor}.${patch + 1}`;
  if (change === "minor") return `0.${minor + 1}.0`;
  if (/^0\.\d+\.\d+$/.test(change)) return change;
  throw new Error("Usage: node scripts/version.mjs <patch|minor|0.x.y|check> [--dry-run]");
}

async function main() {
  const [change, ...flags] = process.argv.slice(2);
  if (change === undefined)
    throw new Error("Missing version change: patch, minor, 0.x.y, or check");
  const packagePath = join(root, "package.json");
  const current = JSON.parse(await readFile(packagePath, "utf8")).version;
  if (change === "check") {
    await checkVersions(current);
    process.stdout.write(`All package and runtime versions match ${current}.\n`);
    return;
  }
  const next = nextZeroVersion(current, change);
  if (flags.includes("--dry-run")) {
    process.stdout.write(`${current} -> ${next}\n`);
    return;
  }
  await Promise.all(jsonFiles.map((file) => updateJson(file, next)));
  await Promise.all(textFiles.map((file) => replaceVersion(file, current, next)));
  process.stdout.write(
    `Bumped ${current} -> ${next}. Run vp install, vp check, vp test, and vp build.\n`,
  );
}

async function updateJson(file, version) {
  const path = join(root, file);
  const value = JSON.parse(await readFile(path, "utf8"));
  value.version = version;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function replaceVersion(file, current, next) {
  const path = join(root, file);
  const source = await readFile(path, "utf8");
  if (!source.includes(current)) throw new Error(`${file} does not contain ${current}`);
  await writeFile(path, source.replaceAll(current, next), "utf8");
}

async function checkVersions(expected) {
  for (const file of jsonFiles) {
    const version = JSON.parse(await readFile(join(root, file), "utf8")).version;
    if (version !== expected) throw new Error(`${file}: expected ${expected}, found ${version}`);
  }
  for (const file of textFiles) {
    if (!(await readFile(join(root, file), "utf8")).includes(expected))
      throw new Error(`${file}: missing ${expected}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
