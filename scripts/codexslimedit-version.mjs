import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-dev\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/;
const VERSION_IDENTIFIER = "CODEX_SLIM_EDIT_VERSION";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "packages", "codexslimedit", "package.json");
const sourcePath = join(root, "packages", "codexslimedit", "src", "version.ts");
const mcpConfigPath = join(root, "packages", "plugin", "plugin", ".mcp.json");

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

/** Selects the CodexSlimEdit MCP distribution channel for a package version. */
export function replaceCodexSlimEditMcpSpec(source, version) {
  assertVersion(version);
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("CodexSlimEdit MCP config must contain valid JSON.");
  }
  const servers = isRecord(config) ? config.mcpServers : undefined;
  const server = isRecord(servers) ? servers.codexslimedit : undefined;
  if (
    !isRecord(server) ||
    server.command !== "bunx" ||
    !Array.isArray(server.args) ||
    server.args.length !== 1 ||
    !["codexslimedit@latest", "codexslimedit@dev"].includes(server.args[0])
  ) {
    throw new Error(
      "CodexSlimEdit MCP server must use bunx with exactly one @latest or @dev package spec.",
    );
  }
  const packageSpec = version.includes("-dev.") ? "codexslimedit@dev" : "codexslimedit@latest";
  return `${JSON.stringify(
    {
      ...config,
      mcpServers: {
        ...servers,
        codexslimedit: { ...server, args: [packageSpec] },
      },
    },
    null,
    2,
  )}\n`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const [manifestSource, versionSource, mcpConfigSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(sourcePath, "utf8"),
    readFile(mcpConfigPath, "utf8"),
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
  const nextMcpConfigSource = replaceCodexSlimEditMcpSpec(mcpConfigSource, version);
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`, "utf8");
  await writeFile(sourcePath, nextVersionSource, "utf8");
  await writeFile(mcpConfigPath, nextMcpConfigSource, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
