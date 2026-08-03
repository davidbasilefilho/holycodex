import { delimiter } from "node:path";

export type Context7Command = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
};

type ExecutableLookup = (name: string) => boolean;

const RUNNERS = [
  { executable: "nubx", command: "nubx", prefix: ["-y"] },
  { executable: "nub", command: "nub", prefix: ["dlx"] },
  { executable: "bunx", command: "bunx", prefix: [] },
  { executable: "bun", command: "bun", prefix: ["x"] },
  { executable: "pnpmx", command: "pnpmx", prefix: [] },
  { executable: "pnpm", command: "pnpm", prefix: ["dlx"] },
  { executable: "npmx", command: "npmx", prefix: ["--yes"] },
  { executable: "npm", command: "npx", prefix: ["--yes"] },
  { executable: "yarn", command: "yarn", prefix: ["dlx"] },
] as const;

/** Constructs the supported direct Context7 invocation for the first available runner. */
export function context7Command(
  args: readonly string[],
  executableExists: ExecutableLookup = executableOnPath,
  env: NodeJS.ProcessEnv = process.env,
): Context7Command | undefined {
  const runner = RUNNERS.find((candidate) => executableExists(candidate.executable));
  if (runner === undefined) return undefined;
  return {
    command: runner.command,
    args: [...runner.prefix, "ctx7@latest", ...args],
    env: { ...env, CI: env.CI ?? "1" },
  };
}

/** Reports whether an executable can be resolved from PATH. */
export function executableOnPath(name: string): boolean {
  const path = process.env.PATH;
  if (path === undefined) return false;
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      try {
        if (process.getBuiltinModule("node:fs").existsSync(`${directory}/${name}${extension}`))
          return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}
