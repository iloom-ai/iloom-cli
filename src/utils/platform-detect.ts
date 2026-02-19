import { readFileSync } from 'node:fs'
import { execa } from 'execa'

/**
 * Terminal environment types.
 * 'darwin' = macOS, 'wsl' = Windows Subsystem for Linux, 'linux' = native Linux, 'win32' = native Windows
 */
export type TerminalEnvironment = 'darwin' | 'wsl' | 'linux' | 'win32' | 'unsupported'

let cachedIsWSL: boolean | undefined

/**
 * Detect if running inside Windows Subsystem for Linux.
 *
 * Detection strategy (in order):
 * 1. Check WSL_DISTRO_NAME env var (always set in WSL2, most reliable)
 * 2. Fallback: read /proc/version for "microsoft" or "WSL" signature
 *
 * Result is cached to avoid repeated /proc reads.
 */
export function isWSL(): boolean {
	if (cachedIsWSL !== undefined) {
		return cachedIsWSL
	}

	// Must be linux for WSL
	if (process.platform !== 'linux') {
		cachedIsWSL = false
		return false
	}

	// Most reliable: WSL_DISTRO_NAME is always set in WSL2
	if (process.env.WSL_DISTRO_NAME) {
		cachedIsWSL = true
		return true
	}

	// Fallback: check /proc/version for WSL signature
	try {
		const procVersion = readFileSync('/proc/version', 'utf-8')
		cachedIsWSL = /microsoft|wsl/i.test(procVersion)
		return cachedIsWSL
	} catch {
		cachedIsWSL = false
		return false
	}
}

/**
 * Detect the terminal environment, distinguishing WSL from plain Linux.
 */
export function detectTerminalEnvironment(): TerminalEnvironment {
	const platform = process.platform
	if (platform === 'darwin') return 'darwin'
	if (platform === 'win32') return 'win32'
	if (platform === 'linux') {
		return isWSL() ? 'wsl' : 'linux'
	}
	return 'unsupported'
}

/**
 * Get the WSL distribution name from the environment.
 * Returns undefined when not running in WSL or when the variable is not set.
 */
export function detectWSLDistro(): string | undefined {
	return process.env.WSL_DISTRO_NAME || undefined // eslint-disable-line @typescript-eslint/prefer-nullish-coalescing -- empty string should be treated as unset
}

/**
 * Check if Windows Terminal (wt.exe) is accessible from the current environment.
 * In WSL, wt.exe is available on PATH when Windows Terminal is installed.
 */
export async function isWindowsTerminalAvailable(): Promise<boolean> {
	try {
		await execa('which', ['wt.exe'])
		return true
	} catch {
		return false
	}
}

/**
 * Reset the cached WSL detection result.
 * Exposed for testing only.
 */
export function _resetWSLCache(): void {
	cachedIsWSL = undefined
}
