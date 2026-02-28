import { execa } from 'execa'
import { existsSync } from 'node:fs'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence } from './command-builder.js'

/**
 * Detect if iTerm2 is installed on macOS.
 */
export function detectITerm2(): boolean {
	return existsSync('/Applications/iTerm.app')
}

/**
 * Escape command string for embedding inside an AppleScript `do script "..."`.
 */
function escapeForAppleScript(command: string): string {
	return command
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
}

/**
 * Build AppleScript for macOS Terminal.app (single tab).
 *
 * Delegates to the shared buildCommandSequence for command construction,
 * then wraps the result with AppleScript escaping for `do script "..."`.
 */
async function buildTerminalAppScript(options: TerminalWindowOptions): Promise<string> {
	const command = await buildCommandSequence(options)

	let script = `tell application "Terminal"\n`
	script += `  set newTab to do script "${escapeForAppleScript(command)}"\n`

	if (options.backgroundColor) {
		const { r, g, b } = options.backgroundColor
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
			for (let i = 0; i < optionsArray.length; i++) {
				const options = optionsArray[i]
				if (!options) {
					throw new Error(`Terminal option at index ${i} is undefined`)
				}
				await this.openSingle(options)

				if (i < optionsArray.length - 1) {
					await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1000))
				}
			}
		}
	}
}
