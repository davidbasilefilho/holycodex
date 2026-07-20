import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { WorkspaceFileError } from "./errors.js";

const RANGE_PATTERN = /^\s*(?<start>[1-9]\d*)\s*(?:-\s*(?<end>[1-9]\d*)\s*)?$/;
const TEMPORARY_FILE_PREFIX = ".codexslimedit-";

/** Input shared by workspace file operations. */
export interface WorkspaceFileInput {
  /** Workspace root used to constrain file access. */
  readonly root: string;
  /** Relative path to the target file. */
  readonly filePath: string;
}

/** Input for a read that may use an explicit full-access capability. */
export interface ReadWorkspaceFileInput extends WorkspaceFileInput {
  /** Allows regular files outside the workspace root. */
  readonly allowOutsideRoot?: boolean;
}

/** Input for an exact-content or inclusive-line-range edit. */
export interface EditWorkspaceFileInput extends WorkspaceFileInput {
  /** Exact text to replace, or an inclusive 1-based `N` or `N-M` line range. */
  readonly oldString: string;
  /** Replacement text. */
  readonly newString: string;
}

/** Content returned by a workspace file operation. */
export interface WorkspaceFileResult {
  /** Canonical root-relative path. */
  readonly path: string;
  /** UTF-8 file content after the operation. */
  readonly content: string;
}

/** Input for writing complete UTF-8 content to a workspace file. */
export interface WriteWorkspaceFileInput extends WorkspaceFileInput {
  /** Complete replacement content. */
  readonly content: string;
}

interface ResolvedWorkspaceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

/** Reads a regular UTF-8 text file inside the workspace root. */
export async function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
): Promise<WorkspaceFileResult> {
  const target = await resolveReadableFile(input);
  return { path: target.relativePath, content: await readUtf8Text(target.absolutePath) };
}

async function resolveReadableFile(input: ReadWorkspaceFileInput): Promise<ResolvedWorkspaceFile> {
  const rootPath = await existingDirectory(input.root);
  const candidate = resolve(rootPath, normalizeSeparators(input.filePath));
  if (!input.allowOutsideRoot && !isInside(rootPath, candidate)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath is outside the workspace root; full-access permission is required.",
    );
  }

  const resolvedCandidate = await realFilePath(candidate);
  if (!input.allowOutsideRoot && !isInside(rootPath, resolvedCandidate)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath resolves outside the workspace root through a symlink; full-access permission is required.",
    );
  }
  return {
    absolutePath: resolvedCandidate,
    relativePath: isInside(rootPath, resolvedCandidate)
      ? relative(rootPath, resolvedCandidate).split(sep).join("/")
      : resolvedCandidate,
  };
}

/** Applies one validated exact-content or inclusive-line-range edit atomically. */
export async function editWorkspaceFile(
  input: EditWorkspaceFileInput,
): Promise<WorkspaceFileResult> {
  const target = await resolveWorkspaceFile(input);
  const content = await readUtf8Text(target.absolutePath);
  const nextContent = replaceContent(content, input.oldString, input.newString);
  validateText(nextContent);
  await atomicWrite(target.absolutePath, nextContent);
  return { path: target.relativePath, content: nextContent };
}

/** Replaces an existing workspace file with complete UTF-8 content. */
export async function writeWorkspaceFile(
  input: WriteWorkspaceFileInput,
): Promise<WorkspaceFileResult> {
  const target = await resolveWorkspaceFile(input);
  validateText(input.content);
  await atomicWrite(target.absolutePath, input.content);
  return { path: target.relativePath, content: input.content };
}

/** Creates a new workspace file in an existing directory. */
export async function createWorkspaceFile(
  input: WriteWorkspaceFileInput,
): Promise<WorkspaceFileResult> {
  const target = await resolveNewWorkspaceFile(input);
  validateText(input.content);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    file = await open(target.absolutePath, "wx", 0o644);
    created = true;
    await file.writeFile(input.content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close();
    if (created) await rm(target.absolutePath, { force: true });
    throw new WorkspaceFileError("WRITE_FAILED", `Could not create filePath: ${message(error)}`);
  }
  return { path: target.relativePath, content: input.content };
}

/** Validates a new workspace file without modifying the workspace. */
export async function prepareWorkspaceFileCreation(
  input: WriteWorkspaceFileInput,
): Promise<WorkspaceFileResult> {
  const target = await resolveNewWorkspaceFile(input, false);
  validateText(input.content);
  return { path: target.relativePath, content: input.content };
}

/** Deletes one existing regular workspace file. */
export async function deleteWorkspaceFile(input: WorkspaceFileInput): Promise<WorkspaceFileResult> {
  const target = await resolveWorkspaceFile(input);
  const requestedPath = resolve(
    await existingDirectory(input.root),
    normalizeSeparators(input.filePath),
  );
  if ((await lstat(requestedPath)).isSymbolicLink()) {
    throw new WorkspaceFileError("NOT_A_FILE", "Deleting symbolic links is not supported.");
  }
  const content = await readUtf8Text(target.absolutePath);
  try {
    await rm(target.absolutePath);
  } catch (error) {
    throw new WorkspaceFileError("WRITE_FAILED", `Could not delete filePath: ${message(error)}`);
  }
  return { path: target.relativePath, content };
}

async function resolveWorkspaceFile(input: WorkspaceFileInput): Promise<ResolvedWorkspaceFile> {
  const rootPath = await existingDirectory(input.root);
  const candidate = resolve(rootPath, normalizeSeparators(input.filePath));
  if (!isInside(rootPath, candidate)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath must remain inside the workspace root.",
    );
  }

  const resolvedCandidate = await realFilePath(candidate);
  if (!isInside(rootPath, resolvedCandidate)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath resolves outside the workspace root through a symlink.",
    );
  }
  return {
    absolutePath: resolvedCandidate,
    relativePath: relative(rootPath, resolvedCandidate).split(sep).join("/"),
  };
}

async function resolveNewWorkspaceFile(
  input: WorkspaceFileInput,
  createParent = true,
): Promise<ResolvedWorkspaceFile> {
  const rootPath = await existingDirectory(input.root);
  const candidate = resolve(rootPath, normalizeSeparators(input.filePath));
  if (!isInside(rootPath, candidate)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath must remain inside the workspace root.",
    );
  }
  try {
    await lstat(candidate);
    throw new WorkspaceFileError("ALREADY_EXISTS", "filePath already exists.");
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
  }
  const parentPath = await safeParent(rootPath, dirname(candidate), createParent);
  const absolutePath = resolve(parentPath, basename(candidate));
  return {
    absolutePath,
    relativePath: relative(rootPath, absolutePath).split(sep).join("/"),
  };
}

async function safeParent(
  rootPath: string,
  requestedParent: string,
  createParent: boolean,
): Promise<string> {
  const missingDirectories: string[] = [];
  let existingParent = requestedParent;
  while (true) {
    try {
      existingParent = await realpath(existingParent);
      break;
    } catch {
      if (existingParent === rootPath) {
        throw new WorkspaceFileError("NOT_FOUND", "Workspace root does not exist.");
      }
      missingDirectories.push(basename(existingParent));
      existingParent = dirname(existingParent);
    }
  }
  if (existingParent !== rootPath && !isInside(rootPath, existingParent)) {
    throw new WorkspaceFileError(
      "PATH_OUTSIDE_ROOT",
      "filePath parent resolves outside the workspace root through a symlink.",
    );
  }
  const parentPath = resolve(existingParent, ...missingDirectories.reverse());
  if (createParent) await mkdir(parentPath, { recursive: true });
  return parentPath;
}

async function existingDirectory(root: string): Promise<string> {
  try {
    const resolvedRoot = await realpath(resolve(root));
    if (!(await stat(resolvedRoot)).isDirectory()) {
      throw new WorkspaceFileError("NOT_A_FILE", "Workspace root must be a directory.");
    }
    return resolvedRoot;
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError("NOT_FOUND", "Workspace root does not exist.");
  }
}

async function realFilePath(candidate: string): Promise<string> {
  try {
    const resolvedCandidate = await realpath(candidate);
    if (!(await stat(resolvedCandidate)).isFile()) {
      throw new WorkspaceFileError("NOT_A_FILE", "filePath must identify a regular file.");
    }
    return resolvedCandidate;
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError("NOT_FOUND", "filePath does not exist.");
  }
}

function normalizeSeparators(filePath: string): string {
  return filePath.replace(/[\\/]/g, sep);
}

function isInside(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative !== "" &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  );
}

async function readUtf8Text(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    throw new WorkspaceFileError("UNREADABLE_FILE", "filePath could not be read.");
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    validateText(content);
    return content;
  } catch {
    throw new WorkspaceFileError(
      "UNSUPPORTED_TEXT",
      "filePath must contain UTF-8 text without NUL bytes.",
    );
  }
}

function validateText(content: string): void {
  if (content.includes("\0")) {
    throw new WorkspaceFileError("UNSUPPORTED_TEXT", "Text must not contain NUL bytes.");
  }
}

function replaceContent(content: string, oldString: string, newString: string): string {
  const range = parseRange(oldString, lineCount(content));
  if (range !== null) return replaceLineRange(content, range.start, range.end, newString);

  const matches = exactMatchOffsets(content, oldString);
  if (matches.length === 1) {
    const [start] = matches;
    return `${content.slice(0, start)}${newString}${content.slice(start + oldString.length)}`;
  }
  if (matches.length > 1) {
    throw new WorkspaceFileError(
      "DUPLICATE_MATCH",
      "oldString matches more than once; provide unique exact content or a line range.",
    );
  }

  throw new WorkspaceFileError(
    "EXACT_MATCH_NOT_FOUND",
    "oldString was not found exactly and is not a valid line range.",
  );
}

function exactMatchOffsets(content: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const offsets: number[] = [];
  let offset = content.indexOf(needle);
  while (offset !== -1) {
    offsets.push(offset);
    offset = content.indexOf(needle, offset + 1);
  }
  return offsets;
}

function parseRange(
  value: string,
  maximum: number,
): { readonly start: number; readonly end: number } | null {
  const match = RANGE_PATTERN.exec(value);
  if (match?.groups === undefined) {
    if (/^\s*\d+(?:\s*-\s*\d+)?\s*$/.test(value)) {
      throw new WorkspaceFileError(
        "INVALID_RANGE",
        `Line range ${value} must use positive 1-based line numbers.`,
      );
    }
    return null;
  }
  const start = Number(match.groups.start);
  const end = Number(match.groups.end ?? match.groups.start);
  if (start > end || end > maximum) {
    throw new WorkspaceFileError(
      "INVALID_RANGE",
      `Line range ${value} is outside the file's 1-${maximum} bounds.`,
    );
  }
  return { start, end };
}

function lineCount(content: string): number {
  return content === ""
    ? 0
    : content.split(/\r\n|\n|\r/).length - Number(endsWithLineBreak(content));
}

function replaceLineRange(content: string, start: number, end: number, newString: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r\n|\n|\r/);
  const hasFinalNewline = endsWithLineBreak(content);
  const editableLines = hasFinalNewline ? lines.slice(0, -1) : lines;
  const replacement = replacementLines(newString, lineEnding);
  const nextLines = [
    ...editableLines.slice(0, start - 1),
    ...replacement,
    ...editableLines.slice(end),
  ];
  if (nextLines.length === 0) return "";
  return `${nextLines.join(lineEnding)}${hasFinalNewline ? lineEnding : ""}`;
}

function replacementLines(newString: string, lineEnding: string): string[] {
  if (newString === "") return [];
  const normalized = normalizeLineEndings(newString, lineEnding);
  const lines = normalized.split(lineEnding);
  return endsWithLineBreak(normalized) ? lines.slice(0, -1) : lines;
}

function endsWithLineBreak(content: string): boolean {
  return /(?:\r\n|\n|\r)$/.test(content);
}

function normalizeLineEndings(content: string, lineEnding: string): string {
  return content.replace(/\r\n|\n|\r/g, lineEnding);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = resolve(
    dirname(path),
    `${TEMPORARY_FILE_PREFIX}${basename(path)}-${crypto.randomUUID()}`,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let writeError: unknown;
  try {
    const originalMode = (await stat(path)).mode & 0o7777;
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await chmod(temporaryPath, originalMode);
    await rename(temporaryPath, path);
  } catch (error) {
    writeError = error;
  }
  const cleanupError = await cleanupTemporaryFile(file, temporaryPath);
  if (writeError !== undefined) {
    throw new WorkspaceFileError(
      "WRITE_FAILED",
      `Could not atomically write filePath: ${message(writeError)}`,
    );
  }
  if (cleanupError !== undefined) {
    throw new WorkspaceFileError(
      "WRITE_FAILED",
      `Could not clean up temporary file: ${message(cleanupError)}`,
    );
  }
}

async function cleanupTemporaryFile(
  file: Awaited<ReturnType<typeof open>> | undefined,
  temporaryPath: string,
): Promise<unknown> {
  try {
    await file?.close();
    await rm(temporaryPath, { force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
