import { execa } from 'execa'
import type { Platform } from '../types/index.js'
import { getTerminalBackend } from './terminal-backends/index.js'
import { detectITerm2 as darwinDetectITerm2 } from './terminal-backends/darwin.js'
import { detectTerminalEnvironment } from './platform-detect.js'

export interface TerminalWindowOptions {
	workspacePath?: string
	command?: string
	backgroundColor?: { r: number; g: number; b: number }
	port?: number
	includeEnvSetup?: boolean // source .env
	includePortExport?: boolean // export PORT=<port>
	title?: string // Terminal tab title
}

/**
 * Detect current platform.
 *
 * Delegates to detectTerminalEnvironment() from platform-detect.ts,
 * mapping 'wsl' back to 'linux' to preserve the Platform return type.
 */
export function detectPlatform(): Platform {
	const env = detectTerminalEnvironment()
	if (env === 'wsl') return 'linux'
	return env
}

/**
 * Theme mode for color palette selection
 */
export type ThemeMode = 'light' | 'dark'

/**
 * Detect macOS dark mode using defaults command
 * Returns 'light' as default for non-macOS platforms or detection failures
 *
 * Uses `defaults read -g AppleInterfaceStyle` which returns "Dark" in dark mode
 * and errors (exit code 1) in light mode. This approach doesn't require
 * System Events permission unlike AppleScript.
 */
export async function detectDarkMode(): Promise<ThemeMode> {
	const platform = detectPlatform()
	if (platform !== 'darwin') {
		return 'light'
	}

	try {
		const result = await execa('defaults', ['read', '-g', 'AppleInterfaceStyle'])
		return result.stdout.trim().toLowerCase() === 'dark' ? 'dark' : 'light'
	} catch {
		// defaults command errors when AppleInterfaceStyle is not set (light mode)
		return 'light'
	}
}

/**
 * Detect if iTerm2 is installed on macOS.
 * Returns false on non-macOS platforms.
 *
 * Delegates to the canonical implementation in darwin.ts.
 */
export async function detectITerm2(): Promise<boolean> {
	if (detectPlatform() !== 'darwin') return false
	return darwinDetectITerm2()
}

/**
 * Open new terminal window with specified options.
 * Supports macOS (Terminal.app/iTerm2), WSL (Windows Terminal),
 * Linux GUI terminals (gnome-terminal/konsole/xterm), and tmux for headless.
 */
export async function openTerminalWindow(
	options: TerminalWindowOptions
): Promise<void> {
	const backend = await getTerminalBackend()
	await backend.openSingle(options)
}

/**
 * Open multiple terminal windows/tabs (2+) with specified options.
 * On macOS with iTerm2, creates a single window with multiple tabs.
 * On WSL, creates multiple Windows Terminal tabs.
 * On Linux, uses the detected terminal emulator or tmux.
 */
export async function openMultipleTerminalWindows(
	optionsArray: TerminalWindowOptions[]
): Promise<void> {
	if (optionsArray.length < 2) {
		throw new Error('openMultipleTerminalWindows requires at least 2 terminal options. Use openTerminalWindow for single terminal.')
	}

	const backend = await getTerminalBackend()
	await backend.openMultiple(optionsArray)
}

/**
 * Open dual terminal windows/tabs with specified options
 * If iTerm2 is available on macOS, creates single window with two tabs
 * Otherwise falls back to two separate Terminal.app windows
 */
export async function openDualTerminalWindow(
	options1: TerminalWindowOptions,
	options2: TerminalWindowOptions
): Promise<void> {
	await openMultipleTerminalWindows([options1, options2])
}
