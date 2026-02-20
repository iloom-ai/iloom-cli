import { logger } from '../utils/logger.js'
import { RemoteDaemonManager } from '../lib/RemoteDaemonManager.js'
import type { RemoteOptions, DaemonStatus } from '../types/remote.js'

/**
 * Default polling interval in seconds (5 minutes)
 */
const DEFAULT_INTERVAL = 300

/**
 * Input for RemoteCommand.execute()
 */
export interface RemoteCommandInput {
	action: string
	options: RemoteOptions
}

/**
 * Error thrown when daemon is already running
 */
export class DaemonAlreadyRunningError extends Error {
	constructor(public readonly pid: number) {
		super(`Daemon is already running (PID ${pid})`)
		this.name = 'DaemonAlreadyRunningError'
	}
}

/**
 * Error thrown for invalid actions
 */
export class InvalidActionError extends Error {
	constructor(public readonly action: string) {
		super(`Invalid action: ${action}. Use start, stop, status, restart, or logs.`)
		this.name = 'InvalidActionError'
	}
}

/**
 * Formats uptime in human-readable form
 */
function formatUptime(seconds: number): string {
	if (seconds < 60) {
		return `${seconds}s`
	}
	if (seconds < 3600) {
		const mins = Math.floor(seconds / 60)
		const secs = seconds % 60
		return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
	}
	const hours = Math.floor(seconds / 3600)
	const mins = Math.floor((seconds % 3600) / 60)
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

/**
 * Formats a Date object for display
 */
function formatDate(date: Date): string {
	return date.toLocaleString()
}

/**
 * RemoteCommand handles the `il remote` CLI command.
 *
 * Subcommands:
 * - start: Start the remote daemon for automatic PR cleanup
 * - stop: Stop the running daemon
 * - status: Show daemon status
 * - restart: Restart the daemon
 * - logs: Show daemon logs (with optional --follow for real-time streaming)
 */
export class RemoteCommand {
	private readonly daemonManager: RemoteDaemonManager

	constructor(daemonManager?: RemoteDaemonManager) {
		this.daemonManager = daemonManager ?? new RemoteDaemonManager()
	}

	/**
	 * Execute the remote command with the given action
	 *
	 * @throws {DaemonAlreadyRunningError} If trying to start when daemon is already running
	 * @throws {InvalidActionError} If action is not recognized
	 * @throws {Error} For other failures
	 */
	async execute(input: RemoteCommandInput): Promise<DaemonStatus | string[]> {
		const { action, options } = input

		switch (action) {
			case 'start':
				return this.handleStart(options)
			case 'stop':
				return this.handleStop(options)
			case 'status':
				return this.handleStatus(options)
			case 'restart':
				return this.handleRestart(options)
			case 'logs':
				if (options.follow) {
					return this.handleFollowLogs(options)
				}
				return this.handleLogs(options)
			default:
				throw new InvalidActionError(action)
		}
	}

	/**
	 * Handle the 'start' action
	 *
	 * @throws {DaemonAlreadyRunningError} If daemon is already running
	 * @throws {Error} If daemon fails to start
	 */
	private async handleStart(options: RemoteOptions): Promise<DaemonStatus> {
		const interval = options.interval ?? DEFAULT_INTERVAL

		// Check if already running
		if (await this.daemonManager.isRunning()) {
			const status = await this.daemonManager.status()
			const pid = status.pid ?? 0
			if (!options.json) {
				logger.warn(`Daemon is already running (PID ${pid})`)
				logger.info(`Use 'il remote restart' to restart with new settings`)
			}
			throw new DaemonAlreadyRunningError(pid)
		}

		await this.daemonManager.start({ interval })
		const status = await this.daemonManager.status()

		if (!options.json) {
			logger.success(`Daemon started (PID ${status.pid}, polling every ${interval}s)`)
		}

		return status
	}

	/**
	 * Handle the 'stop' action
	 *
	 * @throws {Error} If daemon fails to stop
	 */
	private async handleStop(options: RemoteOptions): Promise<DaemonStatus> {
		// Check if running
		if (!(await this.daemonManager.isRunning())) {
			if (!options.json) {
				logger.info('Daemon is not running')
			}
			return { running: false }
		}

		const statusBefore = await this.daemonManager.status()
		await this.daemonManager.stop()

		if (!options.json) {
			logger.success(`Daemon stopped (was PID ${statusBefore.pid})`)
		}

		return { running: false }
	}

	/**
	 * Handle the 'status' action
	 *
	 * @throws {Error} If status cannot be retrieved
	 */
	private async handleStatus(options: RemoteOptions): Promise<DaemonStatus> {
		const status = await this.daemonManager.status()

		if (!options.json) {
			this.printStatus(status)
		}

		return status
	}

	/**
	 * Handle the 'restart' action
	 *
	 * @throws {Error} If daemon fails to restart
	 */
	private async handleRestart(options: RemoteOptions): Promise<DaemonStatus> {
		const interval = options.interval ?? DEFAULT_INTERVAL

		// Stop if running
		if (await this.daemonManager.isRunning()) {
			await this.daemonManager.stop()
			if (!options.json) {
				logger.info('Stopped running daemon')
			}
		}

		// Start with new settings
		await this.daemonManager.start({ interval })
		const status = await this.daemonManager.status()

		if (!options.json) {
			logger.success(`Daemon restarted (PID ${status.pid}, polling every ${interval}s)`)
		}

		return status
	}

	/**
	 * Handle the 'logs' action
	 *
	 * @throws {Error} If logs cannot be read
	 */
	private async handleLogs(options: RemoteOptions): Promise<string[]> {
		const lines = options.lines ?? 50

		const logs = await this.daemonManager.readLogs(lines)

		if (!options.json) {
			if (logs.length === 0) {
				logger.info('No logs found')
			} else {
				logger.info(`Last ${logs.length} log entries:`)
				logger.info('')
				for (const line of logs) {
					// Use process.stdout.write to avoid logger prefix for raw log lines
					process.stdout.write(line + '\n')
				}
			}
		}

		return logs
	}

	/**
	 * Handle the 'logs' action with --follow flag
	 *
	 * Streams log entries in real-time until interrupted.
	 * This method never returns under normal operation - it runs until SIGINT.
	 *
	 * @throws {Error} If log file cannot be accessed
	 */
	private async handleFollowLogs(options: RemoteOptions): Promise<string[]> {
		const lines = options.lines ?? 50
		const collectedLines: string[] = []

		if (!options.json) {
			logger.info('Following logs (Ctrl+C to exit)...')
			logger.info('')
		}

		// Set up signal handler for clean exit
		let cleanup: (() => void) | null = null
		const exitPromise = new Promise<void>((resolve) => {
			const handler = (): void => {
				if (cleanup) {
					cleanup()
				}
				process.removeListener('SIGINT', handler)
				process.removeListener('SIGTERM', handler)
				resolve()
			}
			process.on('SIGINT', handler)
			process.on('SIGTERM', handler)
		})

		// Start following logs
		cleanup = await this.daemonManager.followLogs(
			(line) => {
				collectedLines.push(line)
				if (!options.json) {
					process.stdout.write(line + '\n')
				}
			},
			lines
		)

		// Wait for signal
		await exitPromise

		if (!options.json) {
			logger.info('')
			logger.info('Log following stopped')
		}

		return collectedLines
	}

	/**
	 * Print status in human-readable format
	 */
	private printStatus(status: DaemonStatus): void {
		if (!status.running) {
			logger.info('Daemon status: not running')
			return
		}

		logger.info('Daemon status: running')
		logger.info(`  PID: ${status.pid}`)

		if (status.uptime !== undefined) {
			logger.info(`  Uptime: ${formatUptime(status.uptime)}`)
		}

		if (status.interval !== undefined) {
			logger.info(`  Polling interval: ${status.interval}s`)
		}

		if (status.lastPoll) {
			logger.info(`  Last poll: ${formatDate(status.lastPoll)}`)
		}

		if (status.monitoredLooms !== undefined) {
			logger.info(`  Monitored looms: ${status.monitoredLooms}`)
		}

		if (status.lastPollResult) {
			const result = status.lastPollResult
			logger.info(`  Last poll result:`)
			logger.info(`    Checked: ${result.checked}`)
			logger.info(`    Cleaned: ${result.cleaned}`)
			logger.info(`    Skipped: ${result.skipped}`)
			if (result.errors.length > 0) {
				logger.info(`    Errors: ${result.errors.length}`)
			}
		}
	}
}
