import { execa } from 'execa'
import type { TerminalWindowOptions } from '../terminal.js'
import type { TerminalBackend } from './types.js'
import { buildCommandSequence } from './command-builder.js'
import { logger } from '../logger.js'

/**
 * Check if tmux is available on the system.
 */
export async function isTmuxAvailable(): Promise<boolean> {
	try {
		await execa('which', ['tmux'])
		return true
	} catch (error) {
		// `which` exits with code 1 when the command is not found
		if (error instanceof Error && 'exitCode' in error) {
			return false
		}
		throw error
	}
}

/**
 * Generate a tmux session name from an iloom window title.
 * Strips characters tmux doesn't allow in session names (dots and colons).
 */
function sanitizeSessionName(title: string): string {
	return title
		.replace(/[.:]/g, '-')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.substring(0, 64)
}

/**
 * Generate a tmux window name from an iloom terminal title.
 */
function sanitizeWindowName(title: string): string {
	return title
		.replace(/[.:]/g, '-')
		.substring(0, 32)
}

/**
 * Check if a tmux session already exists.
 */
async function sessionExists(sessionName: string): Promise<boolean> {
	try {
		await execa('tmux', ['has-session', '-t', sessionName])
		return true
	} catch (error) {
		// `tmux has-session` exits with code 1 when the session doesn't exist
		if (error instanceof Error && 'exitCode' in error) {
			return false
		}
		throw error
	}
}

/**
 * tmux backend for headless Linux environments.
 *
 * Used when no GUI terminal emulator is available (SSH sessions, Docker
 * containers, Code Server, CI environments). Creates detached tmux sessions
 * with named windows for each terminal.
 *
 * Background colors are not supported in tmux via this backend.
 */
export class TmuxBackend implements TerminalBackend {
	readonly name = 'tmux'

	async openSingle(options: TerminalWindowOptions): Promise<void> {
		const shellCommand = (await buildCommandSequence(options)).trim()
		// Keep the shell alive after the command exits so users can see output
		// and interact. Mirrors the `; exec bash` pattern in the Linux GUI backend.
		const command = shellCommand ? `${shellCommand}; exec bash` : 'bash'

		if (options.backgroundColor) {
			logger.debug('Terminal background colors are not supported in tmux sessions.')
		}

		const sessionName = options.title
			? sanitizeSessionName(`iloom-${options.title}`)
			: `iloom-${Date.now()}`

		const windowName = options.title
			? sanitizeWindowName(options.title)
			: 'main'

		// Check for an existing iloom session to add a window to
		const iloomSession = await this.findIloomSession()

		if (iloomSession) {
			// Add a new window to the existing iloom session
			const args = ['new-window', '-t', iloomSession, '-n', windowName, 'bash', '-lic', command]
			try {
				await execa('tmux', args)
				logger.info(`Added tmux window "${windowName}" to session "${iloomSession}"`)
			} catch (error) {
				throw new Error(
					`Failed to add tmux window: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		} else {
			// Create a new detached session
			const args = ['new-session', '-d', '-s', sessionName, '-n', windowName, 'bash', '-lic', command]
			try {
				await execa('tmux', args)
				logger.info(`Created tmux session "${sessionName}" — attach with: tmux attach -t ${sessionName}`)
			} catch (error) {
				throw new Error(
					`Failed to create tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		}
	}

	async openMultiple(optionsArray: TerminalWindowOptions[]): Promise<void> {
		if (optionsArray.length === 0) return

		const firstOptions = optionsArray[0]
		if (!firstOptions) {
			throw new Error('First terminal option is undefined')
		}

		// Derive session name from the first window's title or generate one
		const sessionName = firstOptions.title
			? sanitizeSessionName(`iloom-${firstOptions.title}`)
			: `iloom-${Date.now()}`

		// Avoid collision with existing session
		const finalSessionName = await sessionExists(sessionName)
			? `${sessionName}-${Date.now()}`
			: sessionName

		if (firstOptions.backgroundColor) {
			logger.debug('Terminal background colors are not supported in tmux sessions.')
		}

		// Create the session with the first window
		const firstShellCommand = (await buildCommandSequence(firstOptions)).trim()
		const firstCommand = firstShellCommand ? `${firstShellCommand}; exec bash` : 'bash'
		const firstName = firstOptions.title
			? sanitizeWindowName(firstOptions.title)
			: 'window-1'

		try {
			await execa('tmux', [
				'new-session', '-d', '-s', finalSessionName, '-n', firstName,
				'bash', '-lic', firstCommand,
			])
		} catch (error) {
			throw new Error(
				`Failed to create tmux session: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}

		// Add remaining windows
		for (let i = 1; i < optionsArray.length; i++) {
			const options = optionsArray[i]
			if (!options) {
				throw new Error(`Terminal option at index ${i} is undefined`)
			}

			if (options.backgroundColor) {
				logger.debug('Terminal background colors are not supported in tmux sessions.')
			}

			const shellCommand = (await buildCommandSequence(options)).trim()
			const command = shellCommand ? `${shellCommand}; exec bash` : 'bash'
			const windowName = options.title
				? sanitizeWindowName(options.title)
				: `window-${i + 1}`

			try {
				await execa('tmux', [
					'new-window', '-t', finalSessionName, '-n', windowName,
					'bash', '-lic', command,
				])
			} catch (error) {
				throw new Error(
					`Failed to add tmux window "${windowName}": ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		}

		logger.info(
			`Created tmux session "${finalSessionName}" with ${optionsArray.length} windows — ` +
			`attach with: tmux attach -t ${finalSessionName}`
		)
	}

	/**
	 * Look for an existing iloom tmux session to add windows to.
	 * Returns the session name if found, null otherwise.
	 */
	private async findIloomSession(): Promise<string | null> {
		try {
			const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}'])
			const sessions = result.stdout.split('\n').filter(Boolean)
			return sessions.find(s => s.startsWith('iloom-')) ?? null
		} catch (error) {
			// `tmux list-sessions` exits with code 1 when no server is running
			if (error instanceof Error && 'exitCode' in error) {
				return null
			}
			throw error
		}
	}
}
