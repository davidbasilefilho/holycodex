// SPDX-License-Identifier: Apache-2.0

import { freezeDeep, type SafeDetails } from "./common.ts";

export type CoreErrorCode =
  | "catalog_invalid"
  | "crypto_unavailable"
  | "invalid_canonical_value"
  | "invalid_digest_domain"
  | "invalid_input"
  | "invalid_profile"
  | "invalid_route"
  | "invalid_schema_epoch";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details: SafeDetails;

  constructor(
    code: CoreErrorCode,
    message: string,
    details: SafeDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
    freezeDeep(this.details);
    Object.freeze(this);
  }
}

export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CoreError };

export function success<T>(value: T): CoreResult<T> {
  return { ok: true, value };
}

export function failure<T>(error: CoreError): CoreResult<T> {
  return { ok: false, error };
}

export function inputError(field: string, cause?: unknown): CoreError {
  return new CoreError(
    "invalid_input",
    `Invalid ${field}.`,
    { field },
    cause === undefined ? undefined : { cause },
  );
}
