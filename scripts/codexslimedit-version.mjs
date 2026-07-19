import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_IDENTIFIER = "CODEX_SLIM_EDIT_VERSION";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "packages", "codexslimedit", "package.json");
const sourcePath = join(root, "packages", "codexslimedit", "src", "version.ts");

/** Replaces the single CodexSlimEdit source version declaration. */
export function replaceCodexSlimEditVersion(source, version) {
  assertVersion(version);
  const declarations = [
    ...source.matchAll(/export const CODEX_SLIM_EDIT_VERSION = "([^"\r\n]+)";/g),
  ];
  const identifierCount = source.match(/\bCODEX_SLIM_EDIT_VERSION\b/g)?.length ?? 0;
  if (declarations.length !== 1 || identifierCount !== 1) {
    throw new Error("Expected exactly one CODEX_SLIM_EDIT_VERSION declaration in version.ts.");
  }
  assertVersion(declarations[0][1]);
  return source.replace(declarations[0][0], `export const ${VERSION_IDENTIFIER} = "${version}";`);
}

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version ${JSON.stringify(version)}; expected a semantic version.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error("Usage: node scripts/codexslimedit-version.mjs <version>");
  }
  const version = args[0];
  assertVersion(version);
  const [manifestSource, versionSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(sourcePath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("packages/codexslimedit/package.json must contain a string version.");
  }
  assertVersion(manifest.version);
  const nextVersionSource = replaceCodexSlimEditVersion(versionSource, version);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, "utf8");
  await writeFile(sourcePath, nextVersionSource, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
