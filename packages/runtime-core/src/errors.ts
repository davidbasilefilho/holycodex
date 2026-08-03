/** Returns a stable message for an unknown thrown value. */
export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns a stack when available, otherwise a stable error message. */
export function stackOrMessageFromError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
