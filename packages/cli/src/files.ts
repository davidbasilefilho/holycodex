import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function backup(path: string, root: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const target = join(root, path.replace(/^([A-Za-z]:)?[\\/]+/, "").replaceAll(":", ""));
  await mkdir(dirname(target), { recursive: true });
  await copyBackup(path, target);
  return target;
}

async function copyBackup(source: string, target: string): Promise<void> {
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
  for (const entry of await readdir(source)) {
    await copyBackup(join(source, entry), join(target, entry));
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function readText(path: string): Promise<string> {
  return (await exists(path)) ? readFile(path, "utf8") : "";
}
