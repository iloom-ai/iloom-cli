import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { getLogger } from './logger-context.js'

/**
 * Result from creating an ng shim
 */
export interface NgShimResult {
	/** Directory containing the shim script */
	shimDir: string
	/** Cleanup function to remove the shim directory */
	cleanup: () => Promise<void>
}

/**
 * Check if the current platform is Windows
 */
export function isWindows(): boolean {
	return process.platform === 'win32'
}

/**
 * Create a temporary ng shim script that injects --port flag for Angular CLI
 *
 * This is needed because Angular CLI's `ng serve` command requires the port flag
 * to be passed after `--` separator, but npm 10+ has issues with argument passing.
 * The shim intercepts `ng` calls and appends the port flag automatically.
 *
 * Works cross-platform:
 * - Unix (macOS/Linux): Creates executable shell script `ng`
 * - Windows: Creates batch file `ng.cmd`
 *
 * @param port - The port number to inject
 * @param workspacePath - Path to the workspace (used to find real ng binary)
 * @returns Object with shimDir path and cleanup function
 */
export async function createNgShim(port: number, _workspacePath: string): Promise<NgShimResult> {
	const logger = getLogger()

	// Create a unique temp directory for the shim
	const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iloom-ng-shim-'))

	if (isWindows()) {
		// Windows batch file
		// Uses %* to pass through all arguments (equivalent to $@ in shell)
		// Uses backslashes for Windows paths
		// NG_FORCE_TTY=false + stdin from NUL suppresses interactive prompts
		const shimScript = `@echo off
rem iloom Angular CLI shim - injects --port flag
set NG_FORCE_TTY=false
"%ILOOM_WORKSPACE_PATH%\\node_modules\\.bin\\ng.cmd" %* --port %ILOOM_TARGET_PORT% <NUL
`
		const shimPath = path.join(shimDir, 'ng.cmd')
		await fs.writeFile(shimPath, shimScript)

		logger.debug(`Created ng shim (Windows) at ${shimPath} for port ${port}`)
	} else {
		// Unix shell script (macOS/Linux)
		// The shim script passes through all args and appends --port
		// We use environment variables to pass workspace path and port to avoid escaping issues
		// NG_FORCE_TTY=false + stdin from /dev/null suppresses interactive prompts
		// See: packages/angular/cli/src/utilities/tty.ts in angular-cli repo
		const shimScript = `#!/bin/sh
# iloom Angular CLI shim - injects --port flag
echo "" >&2
echo "****************************************" >&2
echo "* ILOOM NG-SHIM ACTIVATED              *" >&2
echo "* Args: $@" >&2
echo "* Port: $ILOOM_TARGET_PORT" >&2
echo "****************************************" >&2
echo "" >&2
export NG_FORCE_TTY=false
exec "$ILOOM_WORKSPACE_PATH/node_modules/.bin/ng" "$@" --port "$ILOOM_TARGET_PORT" </dev/null
`
		const shimPath = path.join(shimDir, 'ng')
		await fs.writeFile(shimPath, shimScript, { mode: 0o755 })

		logger.debug(`Created ng shim (Unix) at ${shimPath} for port ${port}`)
	}

	const cleanup = async (): Promise<void> => {
		try {
			await fs.remove(shimDir)
			logger.debug(`Cleaned up ng shim directory: ${shimDir}`)
		} catch (error) {
			// Log but don't throw - cleanup failures shouldn't break the process
			logger.warn(`Failed to cleanup ng shim directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
		}
	}

	return { shimDir, cleanup }
}
