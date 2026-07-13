import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process$1 from "node:process";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
//#region src/config.ts
var START = "# >>> holycodex managed >>>";
var END = "# <<< holycodex managed <<<";
var OLD_NAMESPACES = [
	"marketplaces.sisyphuslabs",
	"plugins.\"omo@sisyphuslabs\"",
	"marketplaces.lazycodex",
	"plugins.\"omo@lazycodex\"",
	"marketplaces.code-yeongyu-codex-plugins",
	"plugins.\"omo@code-yeongyu-codex-plugins\"",
	"agents.plan",
	"agents.metis",
	"agents.momus",
	"agents.oracle",
	"agents.sisyphus",
	"agents.prometheus",
	"agents.atlas",
	"agents.hephaestus",
	"hooks.state.\"omo@sisyphuslabs",
	"hooks.state.\"omo@lazycodex",
	"hooks.state.\"omo@code-yeongyu-codex-plugins"
];
function removeManaged(input) {
	const escapedStart = START.replaceAll(">", "\\>");
	const escapedEnd = END.replaceAll("<", "\\<");
	return input.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`, "g"), "").trim();
}
function removeLegacyOmo(input) {
	return input.split(/(?=^\s*\[)/m).filter((section) => {
		const header = /^\s*\[([^\]]+)]/.exec(section)?.[1];
		if (header === void 0) return true;
		if (OLD_NAMESPACES.some((name) => header === name || header.startsWith(`${name}.`) || name.includes("\"omo@") && header.startsWith(name))) return false;
		return ![
			"agents.explorer",
			"agents.librarian",
			"agents.worker"
		].some((name) => header === name || header.startsWith(`${name}.`)) || !/(?:sisyphuslabs|omo@|oh-my|code-yeongyu)/i.test(section);
	}).join("").trimEnd();
}
function rewriteForbiddenReasoning(input) {
	return input.split(/(?=^\s*\[)/m).map((section) => {
		const model = /^\s*model\s*=\s*"([^"]+)"/im.exec(section)?.[1]?.toLowerCase();
		if (model === void 0 || !/(?:sol|terra|luna)/.test(model)) return section;
		const allowsHigh = model.includes("luna");
		const rewritten = section.replace(/^(\s*model_reasoning_effort\s*=\s*)"([^"]+)"/gim, (_match, prefix, effort) => {
			const normalized = effort.toLowerCase();
			if (normalized === "low" || normalized === "medium" || allowsHigh && normalized === "high") return `${prefix}"${normalized}"`;
			return `${prefix}"${normalized === "high" ? "medium" : "low"}"`;
		});
		return /^\s*model_reasoning_effort\s*=/im.test(rewritten) ? rewritten : rewritten.replace(/^(\s*model\s*=\s*"[^"]+")/im, "$1\nmodel_reasoning_effort = \"low\"");
	}).join("");
}
function installConfig(input, autonomous) {
	const base = rewriteForbiddenReasoning(removeLegacyOmo(removeManaged(input)));
	const firstTable = base.search(/^\s*\[/m);
	const rootSection = firstTable < 0 ? base : base.slice(0, firstTable);
	const tables = firstTable < 0 ? "" : base.slice(firstTable);
	const preservedRoot = rootSection.replace(/^\s*max_concurrent_threads_per_session\s*=.*\r?\n?/gm, "").replace(autonomous ? /^\s*(?:approval_policy|sandbox_mode)\s*=.*\r?\n?/gm : /$^/g, "").trimEnd();
	const rootBlock = `${START}\n${/^\s*model\s*=/m.test(preservedRoot) ? "" : "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"low\"\n"}${autonomous ? "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n" : ""}max_concurrent_threads_per_session = 2\n${END}`;
	const agents = [
		"explorer",
		"librarian",
		"worker"
	].filter((name) => !new RegExp(`^\\s*\\[agents\\.${name}]`, "m").test(base)).map((name) => `[agents.${name}]\nconfig_file = "holycodex/agents/${name}.toml"`).join("\n\n");
	const pluginBlock = `${START}\n[marketplaces.holycodex]\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true${agents.length > 0 ? `\n\n${agents}` : ""}\n${END}`;
	return `${rootBlock}${preservedRoot.length > 0 ? `\n${preservedRoot}` : ""}${tables.length > 0 ? `\n\n${tables}` : ""}\n\n${pluginBlock}\n`;
}
//#endregion
//#region src/files.ts
async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
async function backup(path, root) {
	if (!await exists(path)) return void 0;
	const target = join(root, path.replace(/^([A-Za-z]:)?[\\/]+/, "").replaceAll(":", ""));
	await mkdir(dirname(target), { recursive: true });
	await copyBackup(path, target);
	return target;
}
async function copyBackup(source, target) {
	const metadata = await lstat(source);
	if (metadata.isSymbolicLink()) {
		await writeFile(`${target}.symlink`, await readlink(source), "utf8");
		return;
	}
	if (!metadata.isDirectory()) {
		await copyFile(source, target);
		return;
	}
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(source)) await copyBackup(join(source, entry), join(target, entry));
}
async function atomicWrite(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, content, "utf8");
	await rename(temporary, path);
}
async function readText(path) {
	return await exists(path) ? readFile(path, "utf8") : "";
}
//#endregion
//#region src/install.ts
var moduleDirectory = dirname(fileURLToPath(import.meta.url));
var packageRoot = join(moduleDirectory, basename(moduleDirectory) === "runtime" ? "../.." : "..");
function paths(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
	const cacheRoot = join(home, "plugins", "cache", "holycodex", "holycodex");
	return {
		home,
		config: join(home, "config.toml"),
		cacheRoot,
		cache: join(cacheRoot, "0.3.0"),
		agents: join(home, "holycodex", "agents"),
		legacy: [
			join(home, "plugins", "cache", "sisyphuslabs", "omo"),
			join(home, "plugins", "cache", "lazycodex", "omo"),
			join(home, "plugins", "cache", "code-yeongyu-codex-plugins", "omo")
		]
	};
}
function backupRoot() {
	return join(tmpdir(), "holycodex-backups", (/* @__PURE__ */ new Date()).toISOString().replaceAll(":", "-"));
}
async function install(options) {
	const target = paths();
	const root = backupRoot();
	const backups = [
		await backup(target.config, root),
		await backup(target.cacheRoot, root),
		await backup(target.agents, root),
		...await Promise.all(target.legacy.map((path) => backup(path, root)))
	].filter((path) => path !== void 0);
	const config = installConfig(await readText(target.config), options.autonomous);
	await atomicWrite(target.config, config);
	await rm(target.cacheRoot, {
		recursive: true,
		force: true
	});
	await mkdir(dirname(target.cache), { recursive: true });
	await cp(join(packageRoot, "plugin"), target.cache, { recursive: true });
	await rm(target.agents, {
		recursive: true,
		force: true
	});
	await cp(join(packageRoot, "plugin", "agents"), target.agents, { recursive: true });
	const removedLegacy = [];
	for (const path of target.legacy) {
		if (!await exists(path)) continue;
		await rm(path, { recursive: true });
		removedLegacy.push(path);
	}
	return {
		action: "install",
		changed: [
			target.config,
			target.cache,
			target.agents,
			...removedLegacy
		],
		backups
	};
}
async function cleanup(_options) {
	const target = paths();
	const root = backupRoot();
	const backups = [
		await backup(target.config, root),
		await backup(target.cacheRoot, root),
		await backup(target.agents, root)
	].filter((path) => path !== void 0);
	const changed = [];
	if (await exists(target.config)) {
		const current = await readText(target.config);
		const unmanaged = removeManaged(current);
		const cleaned = `${unmanaged}\n`;
		if (unmanaged.length === 0 && current.includes("# >>> holycodex managed >>>")) {
			await rm(target.config);
			changed.push(target.config);
		} else if (cleaned !== current) {
			await atomicWrite(target.config, cleaned);
			changed.push(target.config);
		}
	}
	if (await exists(target.cacheRoot)) {
		await rm(target.cacheRoot, { recursive: true });
		changed.push(target.cacheRoot);
	}
	if (await exists(target.agents)) {
		await rm(target.agents, { recursive: true });
		changed.push(target.agents);
	}
	return {
		action: "cleanup",
		changed,
		backups
	};
}
//#endregion
//#region src/cli.ts
var VERSION = "0.3.0";
var HELP = `HolyCodex ${VERSION}\n\nUsage: holycodex <install|cleanup> [options]\n\nOptions:\n  --help              Show help\n  --version           Show version\n  --no-tui            Accepted; commands are noninteractive\n  --codex-autonomous  Set autonomous Codex permissions\n  --json              Print machine-readable result\n`;
async function main() {
	const args = process$1.argv.slice(2);
	if (args.includes("--help") || args.length === 0) {
		process$1.stdout.write(HELP);
		return;
	}
	if (args.includes("--version")) {
		process$1.stdout.write(`${VERSION}\n`);
		return;
	}
	const command = args.find((arg) => !arg.startsWith("--"));
	const options = {
		autonomous: args.includes("--codex-autonomous"),
		json: args.includes("--json")
	};
	const result = command === "install" ? await install(options) : command === "cleanup" ? await cleanup(options) : void 0;
	if (result === void 0) throw new Error(`Unknown command: ${command ?? ""}`);
	process$1.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `HolyCodex ${result.action} complete.\n`);
}
await main();
//#endregion
