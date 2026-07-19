import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await cp("index.d.ts", "dist/index.d.ts");
