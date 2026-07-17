import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.argv[2] ?? join(packageRoot, "dist");

if (!existsSync(distDir)) {
  process.stderr.write(`stamp-dist-version: dist dir not found: ${distDir}\n`);
  process.exit(1);
}

const { name, version } = z
  .looseObject({ name: z.string().min(1), version: z.string().min(1) })
  .parse(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")));

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify({ name, version, type: "module", private: true }, null, "\t") + "\n",
);
