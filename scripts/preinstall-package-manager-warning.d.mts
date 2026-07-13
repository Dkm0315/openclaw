/**
 * Checks a Node version against the standalone package engine-range subset.
 */
export function nodeVersionSatisfiesPackageEngine(
  version: string | null,
  engine: string | null,
): boolean;
/**
 * Reads the Node runtime contract from the package being installed.
 */
export function readPackageNodeEngine(packageJsonUrl?: URL): string | null;
/**
 * Rejects package installation before an unsupported runtime can replace a working release.
 */
export function enforceSupportedNodeRuntime(
  options?: {
    version?: string | null;
    bunVersion?: string | null;
    engine?: string | null;
    execPath?: string | null;
  },
  reportError?: (...data: unknown[]) => void,
): boolean;
/**
 * Detects the package manager running the current lifecycle script.
 */
export function detectLifecyclePackageManager(env?: NodeJS.ProcessEnv): string | null;
/**
 * Builds the warning shown for non-pnpm lifecycle installs.
 */
export function createPackageManagerWarningMessage(packageManager: unknown): string | null;
/**
 * Emits the non-pnpm lifecycle warning when needed.
 */
export function warnIfNonPnpmLifecycle(
  env?: NodeJS.ProcessEnv,
  warn?: (...data: unknown[]) => void,
): boolean;
