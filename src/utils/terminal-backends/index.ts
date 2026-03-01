import { detectTerminalEnvironment } from '../platform-detect.js'
import type { TerminalBackend } from './types.js'

export type { TerminalBackend } from './types.js'

/**
 * Get the appropriate terminal backend for the current platform.
 *
 * - macOS  → DarwinBackend (Terminal.app / iTerm2)
 * - WSL    → WSLBackend (Windows Terminal via wt.exe)
 * - Linux  → LinuxBackend (gnome-terminal / konsole / xterm) with TmuxBackend fallback
 *
 * On Linux, if no GUI terminal emulator is detected (headless SSH, Docker,
 * Code Server, etc.), falls back to tmux automatically.
 *
 * Throws a descriptive error on unsupported platforms or when no backend is available.
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
			// Only try GUI terminals if a display server is available.
			// A terminal emulator like konsole may be installed but unusable
			// without X11/Wayland (e.g., SSH, Docker, Code Server).
			const hasDisplay = !!(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY)

			if (hasDisplay) {
				const { detectLinuxTerminal } = await import('./linux.js')
				if (await detectLinuxTerminal()) {
					const { LinuxBackend } = await import('./linux.js')
					return new LinuxBackend()
				}
			}

			// Fall back to tmux for headless environments
			const { isTmuxAvailable, TmuxBackend } = await import('./tmux.js')
			if (await isTmuxAvailable()) {
				return new TmuxBackend()
			}

			throw new Error(
				'No supported terminal found on Linux. ' +
				'Install tmux for headless environments, or set DISPLAY and install a GUI terminal (gnome-terminal, konsole, xterm).'
			)
		}
		default:
			throw new Error(
				`Terminal window launching is not supported on ${env}. ` +
				'Supported platforms: macOS, WSL (Windows Terminal), Linux (GUI terminals or tmux).'
			)
	}
}
