// SPDX-License-Identifier: Apache-2.0

import type { SafeDetails } from "@holycodex/core";

/** Failure categories emitted while validating or processing plugin assets. */
export type PluginErrorCode =
  | "manifest_invalid"
  | "source_invalid"
  | "path_invalid"
  | "staging_invalid"
  | "payload_invalid"
  | "digest_invalid"
  | "crypto_unavailable";

/** Structured failure raised while validating or processing plugin assets. */
export class PluginError extends Error {
  /** Stable category identifying the plugin operation failure. */
  readonly code: PluginErrorCode;
  /** Safe structured details that help locate the invalid plugin state. */
  readonly details: SafeDetails;

  constructor(
    code: PluginErrorCode,
    message: string,
    details: SafeDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
    Object.freeze(this.details);
    Object.freeze(this);
  }
}

/** Create a typed plugin error with safe diagnostic details and an optional cause. */
export function pluginError(
  code: PluginErrorCode,
  message: string,
  details: SafeDetails = {},
  cause?: unknown,
): PluginError {
  return new PluginError(code, message, details, cause === undefined ? undefined : { cause });
}
