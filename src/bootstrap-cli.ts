import { readinessOutput } from "./bootstrap.ts";

process.stdout.write(await readinessOutput(process.env.PLUGIN_ROOT ?? process.cwd()));
