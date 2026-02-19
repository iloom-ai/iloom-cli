import { execa } from 'execa'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence, rgbToHex } from './command-builder.js'
import { detectWSLDistro } from '../platform-detect.js'

/**
 * Escape a string for use inside `bash -c "..."`.
 * Handles double quotes, backslashes, dollar signs, and backticks.
 */
export function escapeForBashC(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/`/g, '\\`')
}

/**
 * Build wt.exe arguments for a single tab.
 *
 * We use `wsl.exe -d <distro> -e bash -lic "<command>"` as the tab's
 * commandline. The `-e` flag tells wsl.exe to run the given command
 * (instead of the default login shell), and `bash -lic` ensures the
 * user's profile (asdf, nvm, etc.) is loaded.
 */
function buildTabArgs(
	shellCommand: string,
	options: TerminalWindowOptions,
	distro: string | undefined
): string[] {
	const args: string[] = ['new-tab']

	if (options.title) {
		args.push('--title', options.title)
	}

	if (options.backgroundColor) {
		args.push('--tabColor', rgbToHex(options.backgroundColor))
	}

	// The commandline for the tab: wsl.exe runs bash inside the correct distro
	args.push('wsl.exe')

	if (distro) {
		args.push('-d', distro)
	}

	args.push('-e', 'bash', '-lic', shellCommand)

	return args
}

/**
 * WSL terminal backend — uses Windows Terminal (wt.exe) to open tabs
 * running inside the current WSL distribution.
 */
export class WSLBackend implements TerminalBackend {
	readonly name = 'wsl'

	async openSingle(options: TerminalWindowOptions): Promise<void> {
		const shellCommand = await buildCommandSequence(options)
		const distro = detectWSLDistro()
		const args = buildTabArgs(shellCommand, options, distro)

		try {
			await execa('wt.exe', args)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			if (message.includes('ENOENT') || message.includes('not found')) {
				throw new Error(
					'Windows Terminal (wt.exe) is not available. ' +
					'Install Windows Terminal from the Microsoft Store: https://aka.ms/terminal'
				)
			}
			throw new Error(`Failed to open Windows Terminal tab: ${message}`)
		}
	}

	async openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void> {
		const distro = detectWSLDistro()

		// Build combined wt.exe command with multiple new-tab subcommands
		// separated by `;` (wt.exe subcommand separator)
		const allArgs: string[] = []

		for (let i = 0; i < optionsArray.length; i++) {
			const options = optionsArray[i]
			if (!options) {
				throw new Error(`Terminal option at index ${i} is undefined`)
			}

			const shellCommand = await buildCommandSequence(options)
			const tabArgs = buildTabArgs(shellCommand, options, distro)

			if (i > 0) {
				// Separate subcommands with `;`
				allArgs.push(';')
			}

			allArgs.push(...tabArgs)
		}

		try {
			await execa('wt.exe', allArgs)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			if (message.includes('ENOENT') || message.includes('not found')) {
				throw new Error(
					'Windows Terminal (wt.exe) is not available. ' +
					'Install Windows Terminal from the Microsoft Store: https://aka.ms/terminal'
				)
			}
			throw new Error(`Failed to open Windows Terminal tabs: ${message}`)
		}
	}
}
