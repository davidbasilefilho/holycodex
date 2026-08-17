// SPDX-License-Identifier: Apache-2.0

import type { SafeDetails } from "@holycodex/core";

export type PluginErrorCode =
  | "manifest_invalid"
  | "source_invalid"
  | "path_invalid"
  | "staging_invalid"
  | "payload_invalid"
  | "digest_invalid"
  | "crypto_unavailable";

export class PluginError extends Error {
  readonly code: PluginErrorCode;
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

export function pluginError(
  code: PluginErrorCode,
  message: string,
  details: SafeDetails = {},
  cause?: unknown,
): PluginError {
  return new PluginError(code, message, details, cause === undefined ? undefined : { cause });
}
