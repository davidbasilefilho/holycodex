#!/usr/bin/env node
import { a as successResponse, n as errorResponse, o as isPlainRecord, r as jsonRpcId, t as runJsonRpcStdioServer } from "./src-tRIOClWZ.js";
import { join } from "node:path";
import { argv, stderr } from "node:process";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
//#region packages/git-bash-mcp/src/git-bash-resolver.ts
var GIT_BASH_ENV_KEY = "HOLYCODEX_GIT_BASH_PATH";
var PROGRAM_FILES = "C:\\Program Files\\Git\\bin\\bash.exe";
var PROGRAM_FILES_X86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
var INVALID_LAUNCHERS = ["\\windows\\system32\\", "\\microsoft\\windowsapps\\"];
function resolveGitBash(input) {
	if (input.platform !== "win32") return {
		found: true,
		path: null,
		source: "not-required",
		checkedPaths: []
	};
	const checkedPaths = [];
	const configured = input.env[GIT_BASH_ENV_KEY]?.trim();
	if (configured) {
		checkedPaths.push(configured);
		return isBash(configured) && input.exists(configured) ? {
			found: true,
			path: configured,
			source: "env",
			checkedPaths
		} : missing(checkedPaths);
	}
	for (const candidate of [{
		path: PROGRAM_FILES,
		source: "program-files"
	}, {
		path: PROGRAM_FILES_X86,
		source: "program-files-x86"
	}]) {
		checkedPaths.push(candidate.path);
		if (input.exists(candidate.path)) return {
			found: true,
			path: candidate.path,
			source: candidate.source,
			checkedPaths
		};
	}
	for (const raw of input.where("bash")) {
		const candidate = raw.trim();
		if (!candidate) continue;
		checkedPaths.push(candidate);
		const normalized = candidate.replaceAll("/", "\\").toLowerCase();
		if (INVALID_LAUNCHERS.some((part) => normalized.includes(part))) continue;
		if (isBash(candidate) && input.exists(candidate)) return {
			found: true,
			path: candidate,
			source: "path",
			checkedPaths
		};
	}
	return missing(checkedPaths);
}
function resolveGitBashForCurrentProcess(input = {}) {
	return resolveGitBash({
		platform: input.platform ?? process.platform,
		env: input.env ?? process.env,
		exists: existsSync,
		where: (command) => {
			try {
				return execFileSync("where", [command], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
			} catch (error) {
				if (error instanceof Error) return [];
				throw error;
			}
		}
	});
}
function isBash(path) {
	return path.toLowerCase().endsWith("bash.exe");
}
function missing(checkedPaths) {
	return {
		found: false,
		checkedPaths,
		installHint: `Git Bash required. Install: winget install --id Git.Git -e --source winget\nCustom path: set ${GIT_BASH_ENV_KEY}=C:\\path\\to\\bash.exe`
	};
}
//#endregion
//#region packages/git-bash-mcp/src/runner.ts
async function runGitBashCommand(input) {
	return await new Promise((resolve, reject) => {
		const outputDirectory = mkdtempSync(join(tmpdir(), "holycodex-git-bash-run-"));
		const stdoutPath = join(outputDirectory, "stdout");
		const stderrPath = join(outputDirectory, "stderr");
		const stdoutFd = openSync(stdoutPath, "w+");
		const stderrFd = openSync(stderrPath, "w+");
		let outputClosed = false;
		function closeOutputFiles() {
			if (outputClosed) return;
			closeSync(stdoutFd);
			closeSync(stderrFd);
			outputClosed = true;
		}
		function readAndRemoveOutput() {
			closeOutputFiles();
			const stdout = readFileSync(stdoutPath, "utf8");
			const stderr = readFileSync(stderrPath, "utf8");
			rmSync(outputDirectory, {
				recursive: true,
				force: true
			});
			return {
				stdout,
				stderr
			};
		}
		const env = input.env === void 0 ? void 0 : Object.fromEntries(Object.entries(input.env).filter(([key]) => key.toLowerCase() !== "original_path"));
		const child = spawn(input.bashPath, ["-lc", input.command], {
			cwd: input.cwd,
			env,
			windowsHide: true,
			stdio: [
				"ignore",
				stdoutFd,
				stderrFd
			]
		});
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, input.timeoutMs);
		timeout.unref();
		child.on("error", (error) => {
			clearTimeout(timeout);
			closeOutputFiles();
			rmSync(outputDirectory, {
				recursive: true,
				force: true
			});
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolve({
				exitCode,
				...readAndRemoveOutput(),
				timedOut
			});
		});
	});
}
//#endregion
//#region packages/git-bash-mcp/src/mcp.ts
var DEFAULT_TIMEOUT_MS = 12e4;
var MAX_TIMEOUT_MS = 30 * 6e4;
var EXEC_COMMAND_TIMEOUT_ENV_KEYS = [
	"HOLYCODEX_GIT_BASH_TIMEOUT_MS",
	"HOLYCODEX_EXEC_COMMAND_TIMEOUT_MS",
	"CODEX_EXEC_COMMAND_TIMEOUT_MS",
	"EXEC_COMMAND_TIMEOUT_MS"
];
async function handleGitBashMcpRequest(input, options = {}) {
	if (!isPlainRecord(input)) return errorResponse(null, -32600, "Invalid Request");
	const id = jsonRpcId(input["id"]);
	const method = typeof input["method"] === "string" ? input["method"] : null;
	if (method === "initialize") return successResponse(id, {
		capabilities: { tools: { listChanged: false } },
		serverInfo: {
			name: "git_bash",
			version: "0.3.2"
		},
		protocolVersion: protocolVersionFromInput(input) ?? "2024-11-05"
	});
	if (method === "tools/list") return successResponse(id, { tools: toolsForOptions(options) });
	if (method === "tools/call") {
		const params = isPlainRecord(input["params"]) ? input["params"] : {};
		return await callTool(id, typeof params["name"] === "string" ? params["name"] : "", isPlainRecord(params["arguments"]) ? params["arguments"] : {}, options);
	}
	if (method === "notifications/initialized") return void 0;
	return errorResponse(id, -32601, "Method not found");
}
async function runMcpStdioServer(input, output, options = {}) {
	if (!canRunGitBash(options)) return;
	await runJsonRpcStdioServer({
		input,
		output,
		handler: handleGitBashMcpRequest,
		handlerOptions: options,
		idleTimeoutMs: 0,
		log: options.lifecycleLog,
		parseErrorResponse: () => errorResponse(null, -32601, "Method not found")
	});
}
async function callTool(id, name, args, options) {
	if (name === "which_bash") return toolResponse(id, JSON.stringify(resolve$1(options), null, 2));
	if (name === "diagnose") return toolResponse(id, diagnosePayload(resolve$1(options), platformFromOptions(options)));
	if (name === "run") return await runToolResponse(id, args, options);
	return toolResponse(id, `Unknown git_bash tool: ${name}`, true);
}
async function runToolResponse(id, args, options) {
	if (platformFromOptions(options) !== "win32") return toolResponse(id, "git_bash run is only available on native Windows.", true);
	const command = typeof args.command === "string" ? args.command.trim() : "";
	if (command.length === 0) return toolResponse(id, "run.command must be a non-empty string.", true);
	const cwd = parseWorkdir(args);
	if (cwd === null) return toolResponse(id, "run.workdir must be a non-empty string when provided.", true);
	const timeoutMs = parseTimeoutMs(args.timeout ?? args.timeout_ms, options);
	if (timeoutMs === null) return toolResponse(id, `run.timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}.`, true);
	const resolution = resolve$1(options);
	if (!resolution.found || resolution.path === null) return toolResponse(id, JSON.stringify(resolution, null, 2), true);
	try {
		const result = await (options.runGitBash ?? runGitBashCommand)({
			bashPath: resolution.path,
			command,
			cwd,
			timeoutMs,
			env: options.env ?? process.env
		});
		return toolResponse(id, JSON.stringify(result, null, 2));
	} catch (error) {
		return toolResponse(id, error instanceof Error ? error.message : String(error), true);
	}
}
function toolsForOptions(options) {
	const sharedTools = [{
		name: "which_bash",
		description: "Use before Windows shell work when the Git Bash executable path must be confirmed.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false
		}
	}, {
		name: "diagnose",
		description: "Use when git_bash cannot run or Windows shell readiness needs diagnosis.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false
		}
	}];
	if (!canRunGitBash(options)) return sharedTools;
	return [{
		name: "run",
		description: "Use on native Windows for Bash commands, POSIX behavior, Git tooling, or Unix utilities; use exec_command only when git_bash is unavailable or the operation is not shell work.",
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The command to execute."
				},
				timeout: {
					type: "integer",
					minimum: 1,
					maximum: MAX_TIMEOUT_MS,
					description: `Optional timeout in milliseconds. If omitted, uses the inherited exec_command timeout when configured; otherwise ${defaultTimeoutMs(options)}ms.`
				},
				workdir: {
					type: "string",
					description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
				},
				description: {
					type: "string",
					description: "Clear, concise description of what this command does in 5-10 words."
				}
			},
			required: ["command"],
			additionalProperties: false
		}
	}, ...sharedTools];
}
function canRunGitBash(options) {
	if (platformFromOptions(options) !== "win32") return false;
	const resolution = resolve$1(options);
	return resolution.found && resolution.path !== null;
}
function resolve$1(options) {
	if (options.exists === void 0 && options.where === void 0) return resolveGitBashForCurrentProcess({
		platform: options.platform,
		env: options.env
	});
	return resolveGitBash({
		platform: platformFromOptions(options),
		env: options.env ?? process.env,
		exists: options.exists ?? (() => false),
		where: options.where ?? (() => [])
	});
}
function platformFromOptions(options) {
	return options.platform ?? process.platform;
}
function diagnosePayload(resolution, platform) {
	const enabled = platform === "win32" && resolution.found && resolution.path !== null;
	return JSON.stringify({
		platform,
		enabled,
		status: platform === "win32" ? enabled ? "ready" : "missing-git-bash" : "disabled: git_bash command execution is only exposed on native Windows",
		resolution
	}, null, 2);
}
function toolResponse(id, text, isError = false) {
	return successResponse(id, {
		content: [{
			type: "text",
			text
		}],
		isError
	});
}
function parseWorkdir(args) {
	const value = args.workdir ?? args.cwd;
	if (value === void 0) return void 0;
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function parseTimeoutMs(value, options) {
	if (value === void 0) return defaultTimeoutMs(options);
	return normalizeTimeoutMs(value);
}
function defaultTimeoutMs(options) {
	const configured = normalizeTimeoutMs(options.defaultTimeoutMs);
	if (configured !== null) return configured;
	const env = options.env ?? process.env;
	for (const key of EXEC_COMMAND_TIMEOUT_ENV_KEYS) {
		const timeoutMs = normalizeTimeoutMs(env[key]);
		if (timeoutMs !== null) return timeoutMs;
	}
	return DEFAULT_TIMEOUT_MS;
}
function normalizeTimeoutMs(value) {
	const parsed = typeof value === "string" && value.trim().length > 0 ? Number(value) : value;
	if (!Number.isInteger(parsed)) return null;
	const timeoutMs = Number(parsed);
	if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return null;
	return timeoutMs;
}
function protocolVersionFromInput(input) {
	if (!isPlainRecord(input["params"])) return null;
	const params = input["params"];
	return typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : null;
}
//#endregion
//#region packages/git-bash-mcp/src/cli.ts
async function main() {
	const [command = "mcp"] = argv.slice(2);
	if (command === "mcp") {
		await runMcpStdioServer(process.stdin, process.stdout);
		return;
	}
	stderr.write("Usage: holycodex-git-bash [mcp]\n");
	process.exitCode = 2;
}
main().catch((error) => {
	stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
//#endregion
