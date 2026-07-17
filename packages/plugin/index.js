import { fileURLToPath } from "node:url";

export const pluginRoot = fileURLToPath(new URL("./plugin", import.meta.url));
