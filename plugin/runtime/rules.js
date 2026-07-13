#!/usr/bin/env node
import { t as CORE_INSTRUCTIONS } from "./core-instructions-C3FKctng.js";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
//#region src/rules-hook.ts
var DEFAULT_RULE_LIMIT = 8e3;
var DEFAULT_RESULT_LIMIT = 24e3;
var SOURCES = [
	".holycodex/rules",
	".codex/rules",
	".github/instructions"
];
async function loadRules(cwd, targetPath) {
	if (process.env.HOLYCODEX_RULES_DISABLED === "1") return [];
	const candidates = [join(cwd, "CONTEXT.md"), join(cwd, ".github", "copilot-instructions.md")];
	for (const source of SOURCES) candidates.push(...await markdownFiles(join(cwd, source)));
	const rules = [];
	const seen = /* @__PURE__ */ new Set();
	let total = 0;
	for (const path of candidates) {
		const text = await readable(path);
		if (text === void 0) continue;
		const parsed = parseRule(text);
		const staticSource = path.endsWith("CONTEXT.md") || path.endsWith("copilot-instructions.md");
		if (!(targetPath === void 0 ? staticSource || parsed.alwaysApply : parsed.globs.some((glob) => globMatches(glob, relative(cwd, targetPath)))) || parsed.body.length === 0) continue;
		const body = parsed.body.slice(0, numberFromEnv("HOLYCODEX_RULES_MAX_RULE_CHARS", DEFAULT_RULE_LIMIT));
		const hash = createHash("sha256").update(body).digest("hex");
		if (seen.has(hash)) continue;
		if (total + body.length > numberFromEnv("HOLYCODEX_RULES_MAX_RESULT_CHARS", DEFAULT_RESULT_LIMIT)) break;
		seen.add(hash);
		total += body.length;
		rules.push({
			path,
			body
		});
	}
	return rules;
}
async function runRulesHook(input) {
	if (typeof input.cwd !== "string" || typeof input.session_id !== "string") return "";
	const event = input.hook_event_name;
	const cache = cachePath(input.session_id);
	if (event === "PostCompact") {
		await rm(cache, { force: true });
		return `${JSON.stringify({ hookSpecificOutput: {
			hookEventName: event,
			additionalContext: CORE_INSTRUCTIONS
		} })}\n`;
	}
	const target = event === "PostToolUse" ? editPath(input.tool_input, input.cwd) : void 0;
	if (event === "PostToolUse" && target === void 0) return "";
	if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "PostToolUse") return "";
	const emitted = await filterCached(cache, await loadRules(input.cwd, target), typeof input.transcript_path === "string" ? await readable(input.transcript_path) ?? "" : "");
	if (emitted.length === 0) return "";
	const context = emitted.map((rule) => `Rule ${relative(input.cwd, rule.path)}:\n${rule.body}`).join("\n\n");
	return `${JSON.stringify({ hookSpecificOutput: {
		hookEventName: event,
		additionalContext: context
	} })}\n`;
}
function parseRule(text) {
	if (!text.startsWith("---\n")) return {
		alwaysApply: false,
		globs: [],
		body: text.trim()
	};
	const end = text.indexOf("\n---\n", 4);
	if (end < 0) return {
		alwaysApply: false,
		globs: [],
		body: text.trim()
	};
	const header = text.slice(4, end);
	const globs = [...(/^globs:\s*(.+)$/m.exec(header)?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((match) => match[1]).filter((value) => value !== void 0);
	return {
		alwaysApply: /^alwaysApply:\s*true\s*$/m.test(header),
		globs,
		body: text.slice(end + 5).trim()
	};
}
function globMatches(glob, path) {
	const normalized = path.replaceAll("\\", "/");
	const pattern = glob.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
	return new RegExp(`^${pattern}$`).test(normalized);
}
async function markdownFiles(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return (await Promise.all(entries.map(async (entry) => {
			const path = join(root, entry.name);
			return entry.isDirectory() ? markdownFiles(path) : entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
		}))).flat();
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}
async function readable(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return void 0;
		throw error;
	}
}
function editPath(value, cwd) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const input = value;
	for (const key of [
		"filePath",
		"file_path",
		"path",
		"targetPath",
		"target_path"
	]) if (typeof input[key] === "string") return isAbsolute(input[key]) ? input[key] : resolve(cwd, input[key]);
	const patch = typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : void 0;
	const path = patch === void 0 ? void 0 : /^\*\*\* (?:Add|Update) File: (.+)$/m.exec(patch)?.[1]?.trim();
	return path === void 0 ? void 0 : resolve(cwd, path);
}
async function filterCached(path, rules, transcript) {
	const previous = new Set(JSON.parse(await readable(path) ?? "[]"));
	const emitted = rules.filter((rule) => !previous.has(hashRule(rule)) && !transcript.includes(rule.body));
	for (const rule of emitted) previous.add(hashRule(rule));
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify([...previous]), "utf8");
	return emitted;
}
function hashRule(rule) {
	return createHash("sha256").update(rule.body).digest("hex");
}
function cachePath(session) {
	return join(process.env.PLUGIN_DATA ?? join(tmpdir(), "holycodex-plugin-data"), "rules", `${session.replaceAll(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
function numberFromEnv(name, fallback) {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}
//#endregion
//#region src/rules-cli.ts
var raw = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) raw += chunk;
if (raw.trim()) {
	const input = JSON.parse(raw);
	if (typeof input === "object" && input !== null && !Array.isArray(input)) stdout.write(await runRulesHook(input));
}
//#endregion
