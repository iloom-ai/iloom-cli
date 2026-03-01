import { execa } from 'execa'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence } from './command-builder.js'
import { logger } from '../logger.js'

/**
 * Supported Linux GUI terminal emulators in preference order.
 */
const TERMINAL_EMULATORS = ['gnome-terminal', 'konsole', 'xterm'] as const
type LinuxTerminal = (typeof TERMINAL_EMULATORS)[number]

/**
 * Detect which GUI terminal emulator is available on the system.
 * Checks in preference order: gnome-terminal, konsole, xterm.
 * Returns null if none are found (headless environment).
 */
export async function detectLinuxTerminal(): Promise<LinuxTerminal | null> {
	for (const terminal of TERMINAL_EMULATORS) {
		try {
			await execa('which', [terminal])
			return terminal
		} catch (error) {
			// `which` exits with code 1 when the command is not found
			if (error instanceof Error && 'exitCode' in error) {
				continue
			}
			throw error
		}
	}
	return null
}

/**
 * Native Linux GUI terminal backend.
 * Supports gnome-terminal (with tabs), konsole, and xterm (fallback).
 *
 * Background colors are not controllable via CLI on most Linux terminal
 * emulators — a debug message is logged and the color is skipped.
 */
export class LinuxBackend implements TerminalBackend {
	readonly name = 'linux'

	async openSingle(options: TerminalWindowOptions): Promise<void> {
		const terminal = await this.resolveTerminal()
		await this.openSingleWithTerminal(options, terminal)
	}

	async openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void> {
		const terminal = await this.resolveTerminal()

		// gnome-terminal --tab adds a tab to the most recently focused window.
		// Opening sequentially achieves multi-tab behavior reliably without the
		// `--` option parsing issue that breaks multi-tab in a single invocation
		// (gnome-terminal's `--` terminates ALL option parsing, so subsequent
		// --tab flags would be passed to bash as arguments).
		for (let i = 0; i < optionsArray.length; i++) {
			const options = optionsArray[i]
			if (!options) {
				throw new Error(`Terminal option at index ${i} is undefined`)
			}
			await this.openSingleWithTerminal(options, terminal)
		}
	}

	private async resolveTerminal(): Promise<LinuxTerminal> {
		const terminal = await detectLinuxTerminal()
		if (!terminal) {
			throw new Error(
				'No supported GUI terminal emulator found. ' +
				'Install gnome-terminal, konsole, or xterm — or use tmux for headless environments.'
			)
		}
		return terminal
	}

	private async openSingleWithTerminal(
		options: TerminalWindowOptions,
		terminal: LinuxTerminal
	): Promise<void> {
		if (options.backgroundColor) {
			logger.debug(
				'Terminal background colors are not supported via CLI on Linux terminal emulators.'
			)
		}

		const shellCommand = (await buildCommandSequence(options)).trim()
		const keepAliveCommand = shellCommand ? `${shellCommand}; exec bash` : 'exec bash'

		await this.execTerminal(terminal, keepAliveCommand, options.title)
	}

	private async execTerminal(
		terminal: LinuxTerminal,
		command: string,
		title?: string
	): Promise<void> {
		try {
			switch (terminal) {
				case 'gnome-terminal': {
					const args = ['--tab']
					if (title) {
						args.push('--title', title)
					}
					args.push('--', 'bash', '-lic', command)
					await execa('gnome-terminal', args)
					break
				}
				case 'konsole': {
					const args = ['--new-tab']
					if (title) {
						args.push('-p', `tabtitle=${title}`)
					}
					args.push('-e', 'bash', '-lic', command)
					await execa('konsole', args)
					break
				}
				case 'xterm': {
					const args: string[] = []
					if (title) {
						args.push('-title', title)
					}
					args.push('-e', 'bash', '-lic', command)
					await execa('xterm', args)
					break
				}
			}
		} catch (error) {
			throw new Error(
				`Failed to open ${terminal}: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}
}
