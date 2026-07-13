import { readinessContext } from "./bootstrap.ts";

const context = await readinessContext(process.env.PLUGIN_ROOT ?? process.cwd());
if (context.length > 0) process.stdout.write(`${JSON.stringify({ additionalContext: context })}\n`);
