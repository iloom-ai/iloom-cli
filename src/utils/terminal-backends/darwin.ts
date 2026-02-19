import { execa } from 'execa'
import { existsSync } from 'node:fs'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence, escapeSingleQuotes } from './command-builder.js'
import { buildEnvSourceCommands } from '../env.js'

/**
 * Detect if iTerm2 is installed on macOS.
 * Checks for iTerm.app at the standard /Applications location.
 */
export function detectITerm2(): boolean {
	return existsSync('/Applications/iTerm.app')
}

/**
 * Escape command string for embedding inside an AppleScript `do script "..."`.
 * Must handle double quotes and backslashes.
 */
export function escapeForAppleScript(command: string): string {
	return command
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
}

/**
 * Escape path for use inside a single-quoted shell string within AppleScript.
 * (Delegates to the shared single-quote escaper.)
 */
export function escapePathForAppleScript(path: string): string {
	return escapeSingleQuotes(path)
}

/**
 * Build AppleScript for macOS Terminal.app (single tab).
 */
async function buildTerminalAppScript(options: TerminalWindowOptions): Promise<string> {
	const {
		workspacePath,
		command,
		backgroundColor,
		port,
		includeEnvSetup,
		includePortExport,
	} = options

	const commands: string[] = []

	if (workspacePath) {
		commands.push(`cd '${escapePathForAppleScript(workspacePath)}'`)
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
	const historyFreeCommand = ` ${fullCommand}`

	let script = `tell application "Terminal"\n`
	script += `  set newTab to do script "${escapeForAppleScript(historyFreeCommand)}"\n`

	if (backgroundColor) {
		const { r, g, b } = backgroundColor
		script += `  set background color of newTab to {${Math.round(r * 257)}, ${Math.round(g * 257)}, ${Math.round(b * 257)}}\n`
	}

	script += `end tell`
	return script
}

/**
 * Build iTerm2 AppleScript for a single tab in a new window.
 */
async function buildITerm2SingleTabScript(options: TerminalWindowOptions): Promise<string> {
	const command = await buildCommandSequence(options)

	let script = 'tell application id "com.googlecode.iterm2"\n'
	script += '  create window with default profile\n'
	script += '  set s1 to current session of current window\n\n'

	if (options.backgroundColor) {
		const { r, g, b } = options.backgroundColor
		script += `  set background color of s1 to {${Math.round(r * 257)}, ${Math.round(g * 257)}, ${Math.round(b * 257)}}\n`
	}

	script += `  tell s1 to write text "${escapeForAppleScript(command)}"\n\n`

	if (options.title) {
		script += `  set name of s1 to "${escapeForAppleScript(options.title)}"\n\n`
	}

	script += '  activate\n'
	script += 'end tell'

	return script
}

/**
 * Build iTerm2 AppleScript for multiple tabs (2+) in a single window.
 */
async function buildITerm2MultiTabScript(
	optionsArray: TerminalWindowOptions[]
): Promise<string> {
	if (optionsArray.length < 2) {
		throw new Error('buildITerm2MultiTabScript requires at least 2 terminal options')
	}

	let script = 'tell application id "com.googlecode.iterm2"\n'
	script += '  create window with default profile\n'
	script += '  set newWindow to current window\n'

	// First tab
	const options1 = optionsArray[0]
	if (!options1) {
		throw new Error('First terminal option is undefined')
	}
	const command1 = await buildCommandSequence(options1)

	script += '  set s1 to current session of newWindow\n\n'

	if (options1.backgroundColor) {
		const { r, g, b } = options1.backgroundColor
		script += `  set background color of s1 to {${Math.round(r * 257)}, ${Math.round(g * 257)}, ${Math.round(b * 257)}}\n`
	}

	script += `  tell s1 to write text "${escapeForAppleScript(command1)}"\n\n`

	if (options1.title) {
		script += `  set name of s1 to "${escapeForAppleScript(options1.title)}"\n\n`
	}

	// Subsequent tabs
	for (let i = 1; i < optionsArray.length; i++) {
		const options = optionsArray[i]
		if (!options) {
			throw new Error(`Terminal option at index ${i} is undefined`)
		}
		const command = await buildCommandSequence(options)
		const sessionVar = `s${i + 1}`

		script += '  tell newWindow\n'
		script += `    set newTab${i} to (create tab with default profile)\n`
		script += '  end tell\n'
		script += `  set ${sessionVar} to current session of newTab${i}\n\n`

		if (options.backgroundColor) {
			const { r, g, b } = options.backgroundColor
			script += `  set background color of ${sessionVar} to {${Math.round(r * 257)}, ${Math.round(g * 257)}, ${Math.round(b * 257)}}\n`
		}

		script += `  tell ${sessionVar} to write text "${escapeForAppleScript(command)}"\n\n`

		if (options.title) {
			script += `  set name of ${sessionVar} to "${escapeForAppleScript(options.title)}"\n\n`
		}
	}

	script += '  activate\n'
	script += 'end tell'

	return script
}

/**
 * macOS terminal backend — supports Terminal.app and iTerm2.
 */
export class DarwinBackend implements TerminalBackend {
	readonly name = 'darwin'

	async openSingle(options: TerminalWindowOptions): Promise<void> {
		const hasITerm2 = detectITerm2()

		const applescript = hasITerm2
			? await buildITerm2SingleTabScript(options)
			: await buildTerminalAppScript(options)

		try {
			await execa('osascript', ['-e', applescript])

			// Terminal.app needs a separate activation command; iTerm2 script includes its own
			if (!hasITerm2) {
				await execa('osascript', ['-e', 'tell application "Terminal" to activate'])
			}
		} catch (error) {
			throw new Error(
				`Failed to open terminal window: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	async openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void> {
		const hasITerm2 = detectITerm2()

		if (hasITerm2) {
			const applescript = await buildITerm2MultiTabScript(optionsArray)

			try {
				await execa('osascript', ['-e', applescript])
			} catch (error) {
				throw new Error(
					`Failed to open iTerm2 window: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		} else {
			// Fall back to multiple Terminal.app windows
			for (let i = 0; i < optionsArray.length; i++) {
				const options = optionsArray[i]
				if (!options) {
					throw new Error(`Terminal option at index ${i} is undefined`)
				}
				await this.openSingle(options)

				// Brief pause between terminals (except after last one)
				if (i < optionsArray.length - 1) {
					await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1000))
				}
			}
		}
	}
}
