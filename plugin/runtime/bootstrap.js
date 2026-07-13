import { t as CORE_INSTRUCTIONS } from "./core-instructions-D4kR5ZFv.js";
import { access } from "node:fs/promises";
import { join } from "node:path";
//#region src/bootstrap.ts
var REQUIRED = [
	"git-bash.js",
	"lsp.js",
	"rules.js"
];
async function readinessContext(pluginRoot) {
	const missing = [];
	for (const file of REQUIRED) try {
		await access(join(pluginRoot, "runtime", file));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") missing.push(file);
		else throw error;
	}
	if (missing.length === 0) return CORE_INSTRUCTIONS;
	return `${CORE_INSTRUCTIONS}\n\nHolyCodex incomplete: missing runtime/${missing.join(", runtime/")}. Reinstall HolyCodex before using its local MCPs or hooks.`;
}
//#endregion
//#region src/bootstrap-cli.ts
var context = await readinessContext(process.env.PLUGIN_ROOT ?? process.cwd());
if (context.length > 0) process.stdout.write(`${JSON.stringify({ additionalContext: context })}\n`);
//#endregion
