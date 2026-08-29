// SPDX-License-Identifier: Apache-2.0

export { GitBashError, isGitBashError } from "./errors.ts";
export type { GitBashErrorCode, GitBashErrorDetails } from "./errors.ts";
export {
  GIT_BASH_CAPABILITY_NAME,
  GIT_BASH_EXECUTABLE_PATH,
  GIT_BASH_ENV_KEY,
  isRequiredGitBashExecutablePath,
  isSafeGitBashExecutablePath,
  normalizeGitBashExecutablePath,
  resolveGitBash,
  resolveGitBashForCurrentProcess,
} from "./git-bash-resolver.ts";
export type {
  GitBashCapabilityName,
  GitBashCurrentProcessInput,
  GitBashFileProbe,
  GitBashResolution,
  GitBashResolverInput,
  GitBashSource,
} from "./git-bash-resolver.ts";
export { normalizeGitBashEnvironment, runGitBashCommand } from "./runner.ts";
export type { GitBashRunInput, GitBashRunResult, RunGitBashCommand } from "./runner.ts";
