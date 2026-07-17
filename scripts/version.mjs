import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonFiles = [
  "package.json",
  "packages/cli/package.json",
  "packages/plugin/package.json",
  "packages/plugin/plugin/.codex-plugin/plugin.json",
  "packages/git-bash-mcp/package.json",
  "packages/lsp-core/package.json",
  "packages/lsp-daemon/package.json",
  "packages/mcp-stdio-core/package.json",
];
const packageFile = "packages/cli/package.json";
const catalogFile = "packages/cli/src/catalog.ts";
const generatedVersionFiles = ["packages/plugin/plugin/runtime/core-instructions.js"];

export function nextZeroVersion(current, change) {
  const match = /^0\.(\d+)\.(\d+)$/.exec(current);
  if (match === null) throw new Error(`Expected zerover version, received: ${current}`);
  const minor = Number(match[1]);
  const patch = Number(match[2]);
  if (change === "patch") return `0.${minor}.${patch + 1}`;
  if (change === "minor") return `0.${minor + 1}.0`;
  if (/^0\.\d+\.\d+$/.test(change)) return change;
  throw new Error(
    "Usage: node scripts/version.mjs <patch|minor|0.x.y|check> [--dry-run] or dev <run-number> <run-attempt>",
  );
}

export function nextDevVersion(current, runNumber, runAttempt) {
  if (!/^0\.\d+\.\d+$/.test(current) || !/^\d+$/.test(runNumber ?? ""))
    throw new Error("Usage: node scripts/version.mjs dev <run-number> <run-attempt>");
  if (!/^\d+$/.test(runAttempt ?? ""))
    throw new Error("Usage: node scripts/version.mjs dev <run-number> <run-attempt>");
  return `${current}-dev.${Number(runNumber)}.${Number(runAttempt)}`;
}

async function main() {
  const [change, ...flags] = process.argv.slice(2);
  if (change === undefined)
    throw new Error("Missing version change: patch, minor, 0.x.y, dev, or check");
  const packagePath = join(root, packageFile);
  const current = JSON.parse(await readFile(packagePath, "utf8")).version;
  if (change === "check") {
    await checkVersions(current);
    process.stdout.write(`All package and runtime versions match ${current}.\n`);
    return;
  }
  const next =
    change === "dev"
      ? nextDevVersion(current, flags[0], flags[1])
      : nextZeroVersion(current, change);
  if (flags.includes("--dry-run")) {
    process.stdout.write(`${current} -> ${next}\n`);
    return;
  }
  await Promise.all(jsonFiles.map((file) => updateJson(file, next)));
  await replaceVersion(catalogFile, current, next);
  process.stdout.write(
    `Bumped ${current} -> ${next}. Run vp install, vp check, vp test, and vp build.\n`,
  );
}

async function updateJson(file, version) {
  const path = join(root, file);
  const value = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    `${JSON.stringify(versionedJson(file, value, version), null, 2)}\n`,
    "utf8",
  );
}

export function versionedJson(file, value, version) {
  const next = { ...value, version };
  if (file !== packageFile) return next;
  return { ...next, dependencies: { ...value.dependencies, "@holycodex/plugin": version } };
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
  const cli = JSON.parse(await readFile(join(root, packageFile), "utf8"));
  if (cli.dependencies["@holycodex/plugin"] !== expected)
    throw new Error(`${packageFile}: @holycodex/plugin must match ${expected}`);
  if (!(await readFile(join(root, catalogFile), "utf8")).includes(`VERSION = "${expected}"`))
    throw new Error(`${catalogFile}: missing ${expected}`);
  for (const file of generatedVersionFiles)
    if (!(await readFile(join(root, file), "utf8")).includes(expected))
      throw new Error(`${file}: missing ${expected}; rebuild generated runtime`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
