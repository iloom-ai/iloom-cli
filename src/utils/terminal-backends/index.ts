import { detectTerminalEnvironment } from '../platform-detect.js'
import type { TerminalBackend } from './types.js'

export type { TerminalBackend } from './types.js'

/**
 * Get the appropriate terminal backend for the current platform.
 *
 * - macOS → DarwinBackend (Terminal.app / iTerm2)
 * - WSL   → WSLBackend (Windows Terminal via wt.exe)
 * - Linux → LinuxBackend (gnome-terminal / konsole / xterm)
 *
 * Throws a descriptive error on unsupported platforms.
 */
export async function getTerminalBackend(): Promise<TerminalBackend> {
	const env = detectTerminalEnvironment()

	switch (env) {
		case 'darwin': {
			const { DarwinBackend } = await import('./darwin.js')
			return new DarwinBackend()
		}
		case 'wsl': {
			const { WSLBackend } = await import('./wsl.js')
			return new WSLBackend()
		}
		case 'linux': {
			const { LinuxBackend } = await import('./linux.js')
			return new LinuxBackend()
		}
		default:
			throw new Error(
				`Terminal window launching is not supported on ${env}. ` +
				`Supported platforms: macOS, WSL (Windows Terminal), and Linux (gnome-terminal/konsole/xterm).`
			)
	}
}
