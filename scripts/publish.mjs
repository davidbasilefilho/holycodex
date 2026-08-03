import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const packages = ["./packages/plugin", "./packages/cli"];
const visibilityAttempts = 12;
const visibilityDelayMs = 5000;

/** Returns the registry lookup key for a package manifest. */
export function packageSpec({ name, version }) {
  return `${name}@${version}`;
}

/** Decides whether each package may be published without overwriting a registry version. */
export function publicationPlan(localPackages, registryIntegrities) {
  return localPackages.map((localPackage) => {
    const registryIntegrity = registryIntegrities.get(packageSpec(localPackage));
    if (registryIntegrity === undefined) return { ...localPackage, action: "publish" };
    if (registryIntegrity !== localPackage.integrity)
      throw new Error(
        `${packageSpec(localPackage)} already exists with a different integrity; refusing to overwrite it`,
      );
    return { ...localPackage, action: "skip" };
  });
}

/** Reads the public package name and version from a package directory. */
export async function packageManifest(directory) {
  const value = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
  if (typeof value.name !== "string" || typeof value.version !== "string")
    throw new Error(`${directory}/package.json must provide a name and version`);
  const dependencies =
    value.dependencies !== null && typeof value.dependencies === "object" ? value.dependencies : {};
  return { name: value.name, version: value.version, dependencies };
}

/** Computes the integrity npm would assign to a package without running package scripts. */
export async function packageIntegrity(directory) {
  const { stdout } = await execFile(
    "npm",
    ["pack", directory, "--json", "--dry-run", "--ignore-scripts"],
    { cwd: root },
  );
  const packed = JSON.parse(stdout);
  const integrity = packed[0]?.integrity;
  if (typeof integrity !== "string")
    throw new Error(`npm pack did not return integrity for ${directory}`);
  return integrity;
}

/** Returns the published integrity, or undefined only when that exact package version is absent. */
export async function registryIntegrity(spec) {
  try {
    const { stdout } = await execFile(
      "npm",
      ["view", spec, "dist.integrity", "--json", `--registry=${registry}`],
      { cwd: root },
    );
    const integrity = JSON.parse(stdout);
    if (typeof integrity !== "string")
      throw new Error(`npm view did not return integrity for ${spec}`);
    return integrity;
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    if (stderr.includes("E404")) return undefined;
    throw error;
  }
}

/** Waits for npm to expose an exact package integrity, with a bounded retry budget. */
export async function waitForRegistryIntegrity(spec, expectedIntegrity) {
  for (let attempt = 1; attempt <= visibilityAttempts; attempt += 1) {
    if ((await registryIntegrity(spec)) === expectedIntegrity) return;
    if (attempt < visibilityAttempts)
      await new Promise((resolve) => setTimeout(resolve, visibilityDelayMs));
  }
  throw new Error(`${spec} did not become visible with the expected integrity`);
}

/** Reads an exact published version or the version assigned to a dist-tag. */
export async function registryVersion(packageName, field) {
  const { stdout } = await execFile(
    "npm",
    ["view", packageName, field, "--json", `--registry=${registry}`],
    { cwd: root },
  );
  const value = JSON.parse(stdout);
  if (typeof value !== "string")
    throw new Error(`npm view did not return ${field} for ${packageName}`);
  return value;
}

/** Verifies the exact version and intended dist-tag after npm publication. */
export async function verifyPublication(item, channel) {
  const spec = packageSpec(item);
  const exactVersion = await registryVersion(spec, "version");
  const distTagVersion = await registryVersion(item.name, `dist-tags.${channel}`);
  if (exactVersion !== item.version || distTagVersion !== item.version)
    throw new Error(
      `${spec} verification failed: exact=${exactVersion}, ${channel}=${distTagVersion}`,
    );
}

/** Waits for npm to expose an exact version and dist-tag, with a bounded retry budget. */
export async function waitForPublicationVerification(item, channel) {
  let lastError;
  for (let attempt = 1; attempt <= visibilityAttempts; attempt += 1) {
    try {
      await verifyPublication(item, channel);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < visibilityAttempts)
        await new Promise((resolve) => setTimeout(resolve, visibilityDelayMs));
    }
  }
  throw lastError;
}

/** Emits a concise GitHub Actions-compatible publication summary. */
export function publicationSummary(item, channel, result) {
  return `::notice title=npm publication::package=${item.name} version=${item.version} result=${result} tag=${channel}`;
}

/** Writes a concise publication status to Actions output and its optional step summary. */
async function writeStatus(status) {
  process.stdout.write(`${status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${status}\n`, "utf8");
}

/** Publishes or safely skips the two public packages, always processing the plugin first. */
export async function publish(channel, dryRun) {
  if (channel !== "dev" && channel !== "latest") throw new Error("Channel must be dev or latest");
  const localPackages = await Promise.all(
    packages.map(async (directory) => ({
      directory,
      ...(await packageManifest(directory)),
      integrity: await packageIntegrity(directory),
    })),
  );
  const [plugin, cli] = localPackages;
  if (cli.dependencies[plugin.name] !== plugin.version)
    throw new Error(`${cli.name} must depend on ${plugin.name} at exactly ${plugin.version}`);
  const existing = new Map();
  for (const localPackage of localPackages) {
    const integrity = await registryIntegrity(packageSpec(localPackage));
    if (integrity !== undefined) existing.set(packageSpec(localPackage), integrity);
  }
  const plan = publicationPlan(localPackages, existing);
  for (const item of plan) {
    if (item.action === "skip") {
      await writeStatus(publicationSummary(item, channel, "existing"));
      continue;
    }
    const arguments_ = [
      "publish",
      item.directory,
      "--access",
      "public",
      "--tag",
      channel,
      "--provenance",
    ];
    if (dryRun) arguments_.push("--dry-run");
    await execFile("npm", arguments_, { cwd: root });
    await writeStatus(publicationSummary(item, channel, dryRun ? "planned" : "published"));
    if (!dryRun) await waitForRegistryIntegrity(packageSpec(item), item.integrity);
  }
  if (dryRun) return;
  for (const item of plan) {
    await waitForPublicationVerification(item, channel);
    await writeStatus(publicationSummary(item, channel, "verified"));
  }
}

/** Parses the supported publication command and executes it. */
async function main() {
  const [kind, ...flags] = process.argv.slice(2);
  if ((kind !== "dev" && kind !== "stable") || flags.some((flag) => flag !== "--dry-run"))
    throw new Error("Usage: node scripts/publish.mjs <dev|stable> [--dry-run]");
  await publish(kind === "stable" ? "latest" : "dev", flags.includes("--dry-run"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
