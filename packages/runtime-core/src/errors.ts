// SPDX-License-Identifier: Apache-2.0

export type RuntimeCoreErrorCode = "invalid_input";

export class RuntimeCoreError extends Error {
  readonly code: RuntimeCoreErrorCode;

  constructor(code: RuntimeCoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeCoreError";
    this.code = code;
    Object.freeze(this);
  }
}
