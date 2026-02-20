import { execa } from 'execa'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence } from './command-builder.js'
import { logger } from '../logger.js'

/**
 * Supported Linux terminal emulators in preference order.
 */
const TERMINAL_EMULATORS = ['gnome-terminal', 'konsole', 'xterm'] as const
type LinuxTerminal = (typeof TERMINAL_EMULATORS)[number]

/**
 * Detect which terminal emulator is available on the system.
 * Checks in preference order: gnome-terminal, konsole, xterm.
 */
export async function detectLinuxTerminal(): Promise<LinuxTerminal | null> {
	for (const terminal of TERMINAL_EMULATORS) {
		try {
			await execa('which', [terminal])
			return terminal
		} catch {
			// not found, try next
		}
	}
	return null
}

/**
 * Native Linux terminal backend.
 * Supports gnome-terminal (tabs), konsole (tabs), and xterm (fallback, no tabs).
 *
 * Background colors are not controllable via CLI on most Linux terminal
 * emulators — a debug message is logged and the color is skipped.
 */
export class LinuxBackend implements TerminalBackend {
	readonly name = 'linux'

	async openSingle(options: TerminalWindowOptions): Promise<void> {
		const terminal = await detectLinuxTerminal()
		if (!terminal) {
			throw new Error(
				'No supported terminal emulator found. ' +
				'Install gnome-terminal, konsole, or xterm.'
			)
		}

		if (options.backgroundColor) {
			logger.debug(
				'Terminal background colors are not supported via CLI on Linux terminal emulators. ' +
				'Color will be applied at the window-manager level if possible.'
			)
		}

		const shellCommand = (await buildCommandSequence(options)).trim()
		// Append `; exec bash` so the tab stays open after the command completes
		const keepAliveCommand = shellCommand ? `${shellCommand}; exec bash` : 'exec bash'

		await this.execTerminal(terminal, keepAliveCommand, options.title)
	}

	async openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void> {
		const terminal = await detectLinuxTerminal()
		if (!terminal) {
			throw new Error(
				'No supported terminal emulator found. ' +
				'Install gnome-terminal, konsole, or xterm.'
			)
		}

		if (terminal === 'gnome-terminal') {
			// gnome-terminal supports multi-tab in a single invocation
			await this.openGnomeTerminalMultiTab(optionsArray)
		} else {
			// konsole and xterm: open separate windows/tabs sequentially
			for (let i = 0; i < optionsArray.length; i++) {
				const options = optionsArray[i]
				if (!options) {
					throw new Error(`Terminal option at index ${i} is undefined`)
				}
				await this.openSingle(options)
			}
		}
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

	private async openGnomeTerminalMultiTab(
		optionsArray: TerminalWindowOptions[]
	): Promise<void> {
		// gnome-terminal supports multiple --tab flags in a single command
		const args: string[] = []

		for (const options of optionsArray) {
			if (options.backgroundColor) {
				logger.debug(
					'Terminal background colors are not supported via CLI on Linux terminal emulators.'
				)
			}

			const shellCommand = (await buildCommandSequence(options)).trim()
			const keepAliveCommand = shellCommand ? `${shellCommand}; exec bash` : 'exec bash'

			args.push('--tab')
			if (options.title) {
				args.push('--title', options.title)
			}
			args.push('--', 'bash', '-lic', keepAliveCommand)
		}

		try {
			await execa('gnome-terminal', args)
		} catch (error) {
			throw new Error(
				`Failed to open gnome-terminal: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}
}
