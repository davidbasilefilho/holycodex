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

type ReleaseSuffix =
  | Readonly<{
      readonly kind: "development";
      readonly runNumber: string;
      readonly runAttempt: string;
    }>
  | Readonly<{ readonly kind: "base" }>
  | Readonly<{ readonly kind: "numeric"; readonly value: string }>;

type ReleaseVersionParts = Readonly<{
  readonly minor: string;
  readonly patch: string;
  readonly suffix: ReleaseSuffix;
}>;

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

/** Compare two canonical or development release versions using exact decimal ordering. */
export function compareReleaseVersions(left: ReleaseVersion, right: ReleaseVersion): -1 | 0 | 1 {
  const leftParts = releaseVersionParts(left);
  const rightParts = releaseVersionParts(right);
  const minorOrdering = compareDecimalText(leftParts.minor, rightParts.minor);
  if (minorOrdering !== 0) return minorOrdering;
  const patchOrdering = compareDecimalText(leftParts.patch, rightParts.patch);
  if (patchOrdering !== 0) return patchOrdering;
  return compareReleaseSuffixes(leftParts.suffix, rightParts.suffix);
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
  if (minorText === undefined || patchText === undefined) {
    throw new Error(`The canonical version ${current} has an invalid base version.`);
  }
  const minor = BigInt(minorText);
  const patch = BigInt(patchText);
  return target === "minor" ? `0.${minor + 1n}.0` : `0.${minor}.${patch + 1n}`;
}

function releaseVersionParts(value: ReleaseVersion): ReleaseVersionParts {
  const [base, suffix] = value.split("-", 2);
  const baseParts = base?.split(".");
  const minor = baseParts?.[1];
  const patch = baseParts?.[2];
  if (minor === undefined || patch === undefined) {
    throw new Error(`The release version ${value} has an invalid base version.`);
  }
  if (suffix === undefined) return { minor, patch, suffix: { kind: "base" } };
  if (suffix.startsWith("dev.")) {
    const [, runNumber, runAttempt] = suffix.split(".");
    if (runNumber === undefined || runAttempt === undefined) {
      throw new Error(`The development version ${value} has an invalid release suffix.`);
    }
    return {
      minor,
      patch,
      suffix: { kind: "development", runNumber, runAttempt },
    };
  }
  return { minor, patch, suffix: { kind: "numeric", value: suffix } };
}

function compareDecimalText(left: string, right: string): -1 | 0 | 1 {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  return 0;
}

function compareReleaseSuffixes(left: ReleaseSuffix, right: ReleaseSuffix): -1 | 0 | 1 {
  const leftRank = releaseSuffixRank(left);
  const rightRank = releaseSuffixRank(right);
  if (leftRank < rightRank) return -1;
  if (leftRank > rightRank) return 1;
  if (left.kind === "numeric" && right.kind === "numeric") {
    return compareDecimalText(left.value, right.value);
  }
  if (left.kind === "development" && right.kind === "development") {
    const runOrdering = compareDecimalText(left.runNumber, right.runNumber);
    return runOrdering === 0 ? compareDecimalText(left.runAttempt, right.runAttempt) : runOrdering;
  }
  return 0;
}

function releaseSuffixRank(suffix: ReleaseSuffix): 0 | 1 | 2 {
  if (suffix.kind === "development") return 0;
  if (suffix.kind === "base") return 1;
  return 2;
}
