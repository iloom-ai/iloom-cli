import { existsSync } from 'node:fs'
import type { TerminalWindowOptions } from '../terminal.js'
import { buildEnvSourceCommands } from '../env.js'

/**
 * Build the shell command sequence from TerminalWindowOptions.
 *
 * The returned string is a chain of commands joined by ` && `, prefixed with
 * a space to prevent shell history pollution (HISTCONTROL=ignorespace).
 *
 * This logic is shared across all backends — each backend applies its own
 * escaping on top of the raw command string.
 */
export async function buildCommandSequence(options: TerminalWindowOptions): Promise<string> {
	const {
		workspacePath,
		command,
		port,
		includeEnvSetup,
		includePortExport,
	} = options

	const commands: string[] = []

	if (workspacePath) {
		commands.push(`cd '${escapeSingleQuotes(workspacePath)}'`)
	}

	if (includeEnvSetup && workspacePath) {
		const sourceCommands = await buildEnvSourceCommands(
			workspacePath,
			async (p) => existsSync(p)
		)
		commands.push(...sourceCommands)
	}

	if (includePortExport && port !== undefined) {
		commands.push(`export PORT=${port}`)
	}

	if (command) {
		commands.push(command)
	}

	const fullCommand = commands.join(' && ')

	// Prefix with space to prevent shell history pollution
	return ` ${fullCommand}`
}

/**
 * Escape single quotes for use inside a single-quoted shell string.
 * 'it'\''s' → ends quote, adds escaped quote, resumes quote
 */
export function escapeSingleQuotes(s: string): string {
	return s.replace(/'/g, "'\\''")
}

/**
 * Convert {r, g, b} (0–255) to a hex color string "#RRGGBB".
 */
export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
	const toHex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`
}
