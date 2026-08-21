// SPDX-License-Identifier: Apache-2.0

import { domainSeparatedSha256 } from "@holycodex/core";
import { lstat, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertNoSymlink,
  assertNoSymlinkTree,
  ensureOwnedDirectory,
  pathWithin,
} from "./paths.ts";
import { syncDirectory, syncFile } from "./storage.ts";

const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const WORKFLOW_FILE = /^([a-z0-9][a-z0-9-]{0,63})-([0-9a-f]{12})\.ts$/u;

export type SessionWorkflowIdentity = Readonly<{
  readonly sessionId: string;
  readonly name: string;
  readonly digest: string;
  readonly shortHash: string;
  readonly path: string;
}>;

export async function materializeSessionWorkflow(
  stateRoot: string,
  input: Readonly<{ readonly sessionId: string; readonly name: string; readonly source: string }>,
): Promise<SessionWorkflowIdentity> {
  const sessionId = validateSessionId(input.sessionId);
  const name = validateWorkflowName(input.name);
  const source = validateSource(input.source);
  const digest = await workflowDigest(sessionId, name, source);
  const shortHash = digest.slice(0, 12);
  const root = workflowRoot(stateRoot);
  const sessionRoot = sessionWorkflowDirectory(stateRoot, sessionId);
  const path = join(sessionRoot, `${name}-${shortHash}.ts`);

  await ensureOwnedDirectory(root);
  await assertNoSymlinkTree(root);
  await ensureOwnedDirectory(sessionRoot);
  await assertNoSymlinkTree(sessionRoot);
  assertManagedWorkflowPath(root, path);
  await assertNoSymlink(path);

  try {
    const existing = await readRegularWorkflow(path);
    if (existing !== source) {
      throw new SessionWorkflowStoreError(
        "workflow_collision",
        "The deterministic workflow path already contains different content.",
      );
    }
    return { sessionId, name, digest, shortHash, path };
  } catch (error: unknown) {
    if (!isFsCode(error, "ENOENT")) {
      throw error;
    }
  }

  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await syncFile(temporary);
    await rename(temporary, path);
    await syncDirectory(sessionRoot);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return { sessionId, name, digest, shortHash, path };
}

export async function verifySessionWorkflow(
  stateRoot: string,
  identity: SessionWorkflowIdentity,
): Promise<string> {
  const sessionId = validateSessionId(identity.sessionId);
  const name = validateWorkflowName(identity.name);
  const root = workflowRoot(stateRoot);
  const expectedDirectory = sessionWorkflowDirectory(stateRoot, sessionId);
  const path = resolve(identity.path);
  assertManagedWorkflowPath(root, path);
  if (dirname(path) !== resolve(expectedDirectory)) {
    throw new SessionWorkflowStoreError(
      "workflow_identity_mismatch",
      "The workflow path is outside its owning session directory.",
    );
  }
  const match = WORKFLOW_FILE.exec(basename(path));
  if (match?.[1] !== name || match?.[2] !== identity.shortHash) {
    throw new SessionWorkflowStoreError(
      "workflow_identity_mismatch",
      "The workflow filename does not match its stored identity.",
    );
  }
  await assertNoSymlinkTree(expectedDirectory);
  await assertNoSymlink(path);
  const source = await readRegularWorkflow(path);
  const digest = await workflowDigest(sessionId, name, source);
  if (digest !== identity.digest || digest.slice(0, 12) !== identity.shortHash) {
    throw new SessionWorkflowStoreError(
      "workflow_tampered",
      "The persisted workflow content no longer matches its stored identity.",
    );
  }
  return source;
}

export async function cleanupSessionWorkflows(stateRoot: string, sessionIdText: string): Promise<void> {
  const sessionId = validateSessionId(sessionIdText);
  const root = workflowRoot(stateRoot);
  const sessionRoot = sessionWorkflowDirectory(stateRoot, sessionId);
  assertManagedWorkflowPath(root, sessionRoot);
  await assertNoSymlink(root);
  try {
    await assertNoSymlinkTree(sessionRoot);
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) return;
    throw error;
  }
  await rm(sessionRoot, { recursive: true, force: true });
  await syncDirectory(root).catch(() => undefined);
}

export function workflowRoot(stateRoot: string): string {
  return join(resolve(stateRoot), "workflows");
}

export function sessionWorkflowDirectory(stateRoot: string, sessionIdText: string): string {
  return join(workflowRoot(stateRoot), validateSessionId(sessionIdText));
}

async function workflowDigest(sessionId: string, name: string, source: string): Promise<string> {
  return await domainSeparatedSha256("holycodex-session-workflow", [
    new TextEncoder().encode(sessionId),
    new TextEncoder().encode(name),
    new TextEncoder().encode(source),
  ]);
}

function validateSessionId(value: string): string {
  if (!SESSION_ID.test(value)) {
    throw new SessionWorkflowStoreError("workflow_invalid", "The workflow session id is invalid.");
  }
  return value;
}

function validateWorkflowName(value: string): string {
  if (!WORKFLOW_NAME.test(value)) {
    throw new SessionWorkflowStoreError(
      "workflow_invalid",
      "The workflow name must be a concise lowercase filesystem-safe slug.",
    );
  }
  return value;
}

function validateSource(source: string): string {
  if (source.length === 0 || new TextEncoder().encode(source).byteLength > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new SessionWorkflowStoreError("workflow_invalid", "The workflow source is empty or too large.");
  }
  return source;
}

function assertManagedWorkflowPath(root: string, path: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!pathWithin(resolvedRoot, resolvedPath)) {
    throw new SessionWorkflowStoreError(
      "workflow_path_unsafe",
      "The workflow path escapes the HolyCodex workflow root.",
    );
  }
}

async function readRegularWorkflow(path: string): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new SessionWorkflowStoreError(
      "workflow_path_unsafe",
      "The persisted workflow is not a regular owned file.",
    );
  }
  if (entry.size > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new SessionWorkflowStoreError("workflow_invalid", "The persisted workflow is too large.");
  }
  return await readFile(path, "utf8");
}

function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export class SessionWorkflowStoreError extends Error {
  readonly code:
    | "workflow_invalid"
    | "workflow_collision"
    | "workflow_identity_mismatch"
    | "workflow_tampered"
    | "workflow_path_unsafe";

  constructor(code: SessionWorkflowStoreError["code"], message: string) {
    super(message);
    this.name = "SessionWorkflowStoreError";
    this.code = code;
  }
}
