// SPDX-License-Identifier: Apache-2.0

const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Encodes one bounded JSON line for the daemon protocol. */
export function encodeJsonLine(message: unknown): string {
  const encoded = JSON.stringify(message);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES)
    throw new Error("daemon JSON message exceeds the configured bound");
  return `${encoded}\n`;
}
export interface LineDecoder {
  readonly push: (chunk: Buffer | string) => void;
}
/** Creates a fragmentation-safe decoder which reports malformed lines and continues. */
export function createLineDecoder(
  onMessage: (value: unknown) => void,
  onParseError?: (raw: string, error: unknown) => void,
  maxLineBytes = MAX_LINE_BYTES,
): LineDecoder {
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maxLineBytes) {
        onParseError?.("<oversized line>", new Error("daemon line exceeds the configured bound"));
        buffer = "";
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (raw.length > 0) {
          try {
            onMessage(JSON.parse(raw));
          } catch (error: unknown) {
            onParseError?.(raw, error);
          }
        }
        index = buffer.indexOf("\n");
      }
    },
  };
}
