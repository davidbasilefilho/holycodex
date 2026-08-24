// SPDX-License-Identifier: Apache-2.0

/** Returns a bounded diagnostic message from an unknown failure. */
export function messageFromError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}
