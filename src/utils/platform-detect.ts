import { readFileSync } from 'node:fs'

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
	} catch (error: unknown) {
		// /proc/version not found — not WSL
		if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			cachedIsWSL = false
			return false
		}
		// Unexpected error — assume not WSL
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
	const distro = process.env.WSL_DISTRO_NAME
	// Empty string means unset; nullish coalescing won't catch it
	if (!distro) return undefined
	return distro
}

/**
 * Reset the cached WSL detection result.
 * Exposed for testing only.
 */
export function _resetWSLCache(): void {
	cachedIsWSL = undefined
}
