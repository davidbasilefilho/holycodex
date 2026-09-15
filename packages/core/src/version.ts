// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

/** The canonical zerover form, including an optional numeric release suffix. */
export const CANONICAL_VERSION_PATTERN = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*))?$/u;

/** Validate the canonical public package version. */
export const CanonicalVersionSchema = Schema.String.pipe(Schema.pattern(CANONICAL_VERSION_PATTERN));
export type CanonicalVersion = typeof CanonicalVersionSchema.Type;

function decodeCanonicalVersion(value: unknown): CanonicalVersion | undefined {
  const parsed = Schema.decodeUnknownEither(CanonicalVersionSchema)(value);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

/** Return whether an unknown value is a canonical public package version. */
export function isCanonicalVersion(value: unknown): value is CanonicalVersion {
  return decodeCanonicalVersion(value) !== undefined;
}

function isBaseVersion(value: string): boolean {
  return isCanonicalVersion(value) && !value.includes("-");
}

/** Validate a canonical version without a numeric release suffix. */
export const BaseVersionSchema = Schema.String.pipe(Schema.filter(isBaseVersion));
export type BaseVersion = typeof BaseVersionSchema.Type;

function isPositiveIntegerText(value: string | undefined): boolean {
  if (value === undefined || value.length === 0 || value[0] === "0") return false;
  for (const character of value) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

function isDevelopmentVersion(value: string): boolean {
  const [base, suffix, extra] = value.split("-");
  if (base === undefined || suffix === undefined || extra !== undefined) return false;
  if (!isBaseVersion(base)) return false;

  const [kind, runNumber, runAttempt, trailing] = suffix.split(".");
  return (
    kind === "dev" &&
    trailing === undefined &&
    isPositiveIntegerText(runNumber) &&
    isPositiveIntegerText(runAttempt)
  );
}

/** Validate a collision-safe development release version. */
export const DevelopmentVersionSchema = Schema.String.pipe(Schema.filter(isDevelopmentVersion));
export type DevelopmentVersion = typeof DevelopmentVersionSchema.Type;

/** Validate either a canonical stable version or a development release version. */
export const ReleaseVersionSchema = Schema.Union(CanonicalVersionSchema, DevelopmentVersionSchema);
export type ReleaseVersion = typeof ReleaseVersionSchema.Type;

/** Remove a canonical version's optional numeric release suffix. */
export function canonicalBaseVersion(value: string): BaseVersion {
  const canonical = decodeCanonicalVersion(value);
  if (canonical === undefined) {
    throw new Error(`The canonical version ${value} is invalid.`);
  }
  const base = canonical.split("-", 1)[0];
  if (base === undefined) {
    throw new Error(`The canonical version ${value} has no base version.`);
  }
  return base;
}

/** Resolve an explicit canonical version or the next patch or minor version. */
export function resolveCanonicalVersion(target: string, current: string): CanonicalVersion {
  const currentBase = canonicalBaseVersion(current);
  if (target !== "patch" && target !== "minor") {
    if (!isCanonicalVersion(target)) {
      throw new Error("The version target is invalid.");
    }
    return target;
  }

  const [, minorText, patchText] = currentBase.split(".");
  const minor = Number(minorText);
  const patch = Number(patchText);
  return target === "minor" ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`;
}
