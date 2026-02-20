import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import type { DaemonStatus, DaemonConfig } from '../types/remote.js'
import { logger } from '../utils/logger.js'

/**
 * Default paths for daemon state files
 */
const DAEMON_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'remote-daemon')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const LOG_FILE = path.join(DAEMON_DIR, 'daemon.log')
const CONFIG_FILE = path.join(DAEMON_DIR, 'daemon.config.json')
const STATUS_FILE = path.join(DAEMON_DIR, 'daemon.status.json')

/**
 * Options for starting the daemon
 */
export interface DaemonStartOptions {
	/** Polling interval in seconds */
	interval: number
}

/**
 * RemoteDaemonManager handles the lifecycle of the remote daemon process.
 *
 * The daemon is a background process that periodically polls GitHub for
 * closed/merged PRs and triggers cleanup of corresponding local looms.
 *
 * State files are stored in ~/.config/iloom-ai/remote-daemon/:
 * - daemon.pid: Process ID of the running daemon
 * - daemon.log: Log output from the daemon
 * - daemon.config.json: Configuration passed to the daemon
 * - daemon.status.json: Runtime status updated by the daemon
 */
export class RemoteDaemonManager {
	private readonly daemonDir: string
	private readonly pidFile: string
	private readonly logFile: string
	private readonly configFile: string
	private readonly statusFile: string

	constructor(options?: {
		daemonDir?: string
		pidFile?: string
		logFile?: string
		configFile?: string
		statusFile?: string
	}) {
		this.daemonDir = options?.daemonDir ?? DAEMON_DIR
		this.pidFile = options?.pidFile ?? PID_FILE
		this.logFile = options?.logFile ?? LOG_FILE
		this.configFile = options?.configFile ?? CONFIG_FILE
		this.statusFile = options?.statusFile ?? STATUS_FILE
	}

	/**
	 * Start the daemon process
	 *
	 * @param options - Start options including polling interval
	 * @throws Error if daemon is already running
	 */
	async start(options: DaemonStartOptions): Promise<void> {
		// Check if already running
		if (await this.isRunning()) {
			const status = await this.status()
			throw new Error(`Daemon is already running with PID ${status.pid}`)
		}

		// Ensure daemon directory exists with restrictive permissions (0o700)
		// This prevents other users from reading daemon logs which may contain
		// sensitive information like repository paths and PR numbers
		await fs.ensureDir(this.daemonDir, { mode: 0o700 })

		// Write config file for daemon to read
		const config: DaemonConfig = {
			interval: options.interval,
			startedAt: new Date(),
		}
		await fs.writeFile(this.configFile, JSON.stringify(config, null, 2), { mode: 0o644 })

		// Clear previous log file
		await fs.writeFile(this.logFile, '', { mode: 0o644 })

		// Get the path to the runner module
		const runnerPath = this.getRunnerPath()

		// Fork the daemon process
		const child = fork(runnerPath, [String(options.interval)], {
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
			cwd: this.daemonDir,
			env: {
				...process.env,
				ILOOM_DAEMON_DIR: this.daemonDir,
				ILOOM_DAEMON_LOG_FILE: this.logFile,
				ILOOM_DAEMON_STATUS_FILE: this.statusFile,
			},
		})

		// Write PID file
		if (child.pid === undefined) {
			throw new Error('Failed to start daemon: no PID returned')
		}
		await fs.writeFile(this.pidFile, String(child.pid), { mode: 0o644 })

		// Detach from parent process
		child.unref()
		child.disconnect?.()

		logger.debug(`Daemon started with PID ${child.pid}`)
	}

	/**
	 * Stop the daemon process
	 *
	 * Sends SIGTERM and waits up to 5 seconds for graceful shutdown.
	 * Falls back to SIGKILL if process doesn't terminate.
	 *
	 * PID validation: Before killing, we verify the process is our daemon by
	 * checking that the status file has been updated recently. This prevents
	 * accidentally killing a different process if PIDs have been recycled.
	 */
	async stop(): Promise<void> {
		const pid = await this.readPid()
		if (pid === null) {
			logger.debug('No PID file found, daemon may not be running')
			return
		}

		// Check if process is actually running
		if (!this.isProcessAlive(pid)) {
			// Process is dead, clean up stale PID file
			await this.cleanupPidFile()
			logger.debug('Cleaned up stale PID file')
			return
		}

		// Validate that the PID belongs to our daemon by checking heartbeat
		// This prevents killing a recycled PID that belongs to a different process
		const isOurDaemon = await this.validateDaemonHeartbeat()
		if (!isOurDaemon) {
			logger.warn(
				`PID ${pid} exists but daemon heartbeat validation failed. ` +
					'The process may have been recycled. Cleaning up stale PID file without killing.'
			)
			await this.cleanupPidFile()
			return
		}

		// Send SIGTERM for graceful shutdown
		try {
			process.kill(pid, 'SIGTERM')
			logger.debug(`Sent SIGTERM to PID ${pid}`)
		} catch (error) {
			// Process may have died between check and kill
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
				await this.cleanupPidFile()
				return
			}
			throw error
		}

		// Wait for process to terminate (up to 5 seconds)
		const terminated = await this.waitForTermination(pid, 5000)

		if (!terminated) {
			// Force kill if still running
			try {
				process.kill(pid, 'SIGKILL')
				logger.debug(`Sent SIGKILL to PID ${pid}`)
				// Wait a bit for SIGKILL to take effect
				await this.waitForTermination(pid, 1000)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
					throw error
				}
			}
		}

		// Clean up PID file
		await this.cleanupPidFile()
		logger.debug('Daemon stopped and PID file cleaned up')
	}

	/**
	 * Get the current status of the daemon
	 *
	 * @returns DaemonStatus object with running state and optional details
	 */
	async status(): Promise<DaemonStatus> {
		const pid = await this.readPid()

		// No PID file means not running
		if (pid === null) {
			return { running: false }
		}

		// Check if process is actually alive
		if (!this.isProcessAlive(pid)) {
			// Stale PID file - clean it up
			await this.cleanupPidFile()
			return { running: false }
		}

		// Process is running - read status file for details
		const statusInfo = await this.readStatusFile()
		const config = await this.readConfigFile()

		const result: DaemonStatus = {
			running: true,
			pid,
		}

		// Add config info if available
		if (config) {
			result.interval = config.interval
			const startTime = new Date(config.startedAt).getTime()
			const now = Date.now()
			result.uptime = Math.floor((now - startTime) / 1000)
		}

		// Add status file info if available
		if (statusInfo) {
			if (statusInfo.lastPoll) {
				result.lastPoll = new Date(statusInfo.lastPoll)
			}
			if (statusInfo.monitoredLooms !== undefined) {
				result.monitoredLooms = statusInfo.monitoredLooms
			}
			if (statusInfo.lastPollResult) {
				result.lastPollResult = statusInfo.lastPollResult
			}
		}

		return result
	}

	/**
	 * Check if the daemon is currently running
	 *
	 * @returns true if daemon is running, false otherwise
	 */
	async isRunning(): Promise<boolean> {
		const pid = await this.readPid()
		if (pid === null) {
			return false
		}
		return this.isProcessAlive(pid)
	}

	/**
	 * Get the path to the log file
	 */
	getLogFilePath(): string {
		return this.logFile
	}

	/**
	 * Read recent log lines from the daemon log file
	 *
	 * @param lines - Number of lines to read (from the end)
	 * @returns Array of log lines
	 */
	async readLogs(lines: number = 50): Promise<string[]> {
		try {
			if (!(await fs.pathExists(this.logFile))) {
				return []
			}
			const content = await fs.readFile(this.logFile, 'utf8')
			const allLines = content.split('\n').filter(line => line.trim() !== '')
			// Return last N lines
			return allLines.slice(-lines)
		} catch {
			return []
		}
	}

	/**
	 * Follow log file and stream new entries in real-time.
	 *
	 * This method:
	 * 1. Prints existing log lines (up to `initialLines`)
	 * 2. Watches for new content and prints it in real-time
	 * 3. Returns a cleanup function to stop watching
	 *
	 * @param onLine - Callback for each new line
	 * @param initialLines - Number of initial lines to show (default: 50)
	 * @returns Cleanup function to stop watching
	 */
	async followLogs(
		onLine: (line: string) => void,
		initialLines: number = 50
	): Promise<() => void> {
		// Ensure log file exists
		if (!(await fs.pathExists(this.logFile))) {
			// Create empty log file if it doesn't exist
			await fs.ensureDir(this.daemonDir)
			await fs.writeFile(this.logFile, '', { mode: 0o644 })
		}

		// Read and output initial lines
		const existingLines = await this.readLogs(initialLines)
		for (const line of existingLines) {
			onLine(line)
		}

		// Track file position for reading new content
		let fileSize = (await fs.stat(this.logFile)).size

		// Watch for file changes
		const watcher = fs.watch(this.logFile, async (eventType) => {
			if (eventType === 'change') {
				try {
					const newStat = await fs.stat(this.logFile)
					const newSize = newStat.size

					// Only read if file has grown
					if (newSize > fileSize) {
						// Read the entire file and extract only the new content
						// This is simpler than using low-level file descriptors
						const content = await fs.readFile(this.logFile, 'utf8')
						const newContent = content.slice(fileSize)

						// Split into lines and output non-empty ones
						const newLines = newContent.split('\n').filter(line => line.trim() !== '')
						for (const line of newLines) {
							onLine(line)
						}
						fileSize = newSize
					} else if (newSize < fileSize) {
						// File was truncated (e.g., log rotation)
						// Reset position and read from beginning
						fileSize = 0
					}
				} catch {
					// Ignore errors during watch - file might be temporarily unavailable
				}
			}
		})

		// Return cleanup function
		return () => {
			watcher.close()
		}
	}

	/**
	 * Read the PID from the PID file
	 *
	 * @returns PID number or null if file doesn't exist or is invalid
	 */
	private async readPid(): Promise<number | null> {
		try {
			if (!(await fs.pathExists(this.pidFile))) {
				return null
			}
			const content = await fs.readFile(this.pidFile, 'utf8')
			const pid = parseInt(content.trim(), 10)
			if (isNaN(pid) || pid <= 0) {
				return null
			}
			return pid
		} catch {
			return null
		}
	}

	/**
	 * Check if a process is alive using kill(pid, 0)
	 *
	 * @param pid - Process ID to check
	 * @returns true if process exists, false otherwise
	 */
	private isProcessAlive(pid: number): boolean {
		try {
			// Sending signal 0 checks if process exists without killing it
			process.kill(pid, 0)
			return true
		} catch (error) {
			// ESRCH means no such process
			// EPERM means process exists but we don't have permission (still alive)
			return (error as NodeJS.ErrnoException).code === 'EPERM'
		}
	}

	/**
	 * Wait for a process to terminate
	 *
	 * @param pid - Process ID to wait for
	 * @param timeoutMs - Maximum time to wait in milliseconds
	 * @returns true if process terminated, false if timeout
	 */
	private async waitForTermination(pid: number, timeoutMs: number): Promise<boolean> {
		const startTime = Date.now()
		const checkInterval = 100

		while (Date.now() - startTime < timeoutMs) {
			if (!this.isProcessAlive(pid)) {
				return true
			}
			await new Promise(resolve => globalThis.setTimeout(resolve, checkInterval))
		}

		return !this.isProcessAlive(pid)
	}

	/**
	 * Clean up the PID file
	 */
	private async cleanupPidFile(): Promise<void> {
		try {
			await fs.unlink(this.pidFile)
		} catch (error) {
			// Ignore if file doesn't exist
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error
			}
		}
	}

	/**
	 * Read the config file
	 */
	private async readConfigFile(): Promise<DaemonConfig | null> {
		try {
			if (!(await fs.pathExists(this.configFile))) {
				return null
			}
			const content = await fs.readFile(this.configFile, 'utf8')
			return JSON.parse(content) as DaemonConfig
		} catch {
			return null
		}
	}

	/**
	 * Read the status file written by the daemon
	 */
	private async readStatusFile(): Promise<{
		lastPoll?: string
		monitoredLooms?: number
		lastPollResult?: DaemonStatus['lastPollResult']
	} | null> {
		try {
			if (!(await fs.pathExists(this.statusFile))) {
				return null
			}
			const content = await fs.readFile(this.statusFile, 'utf8')
			return JSON.parse(content)
		} catch {
			return null
		}
	}

	/**
	 * Validate that the daemon is actually running by checking its heartbeat.
	 *
	 * This prevents PID recycling issues where a different process may have
	 * taken over the same PID. We check:
	 * 1. Status file exists
	 * 2. Config file exists and was written by us (same start time)
	 * 3. Status file has been updated recently (within 2x polling interval + grace period)
	 *
	 * @returns true if the daemon heartbeat is valid, false otherwise
	 */
	private async validateDaemonHeartbeat(): Promise<boolean> {
		try {
			// Check if config file exists - it must exist if daemon was started by us
			const config = await this.readConfigFile()
			if (!config) {
				logger.debug('Heartbeat validation failed: no config file')
				return false
			}

			// Check if status file exists and has recent activity
			const statusInfo = await this.readStatusFile()
			if (!statusInfo) {
				// Status file may not exist yet if daemon just started and hasn't polled yet
				// In this case, check if config was created recently (within 30 seconds)
				const configTime = new Date(config.startedAt).getTime()
				const timeSinceStart = Date.now() - configTime
				const recentStartGracePeriod = 30000 // 30 seconds
				if (timeSinceStart < recentStartGracePeriod) {
					logger.debug('Heartbeat validation passed: daemon started recently')
					return true
				}
				logger.debug('Heartbeat validation failed: no status file and config is stale')
				return false
			}

			// Check if status file was updated recently
			// Allow 2x the polling interval plus a 60 second grace period
			if (statusInfo.lastPoll) {
				const lastPollTime = new Date(statusInfo.lastPoll).getTime()
				const timeSinceLastPoll = Date.now() - lastPollTime
				const maxStaleTime = config.interval * 2 * 1000 + 60000 // 2x interval + 60s grace
				if (timeSinceLastPoll > maxStaleTime) {
					logger.debug(
						`Heartbeat validation failed: last poll was ${Math.floor(timeSinceLastPoll / 1000)}s ago, ` +
							`max allowed is ${Math.floor(maxStaleTime / 1000)}s`
					)
					return false
				}
			}

			logger.debug('Heartbeat validation passed')
			return true
		} catch (error) {
			logger.debug(`Heartbeat validation error: ${error instanceof Error ? error.message : String(error)}`)
			return false
		}
	}

	/**
	 * Get the path to the daemon runner module
	 *
	 * The runner is the entry point for the forked child process.
	 * It's built as a separate entry point in dist/lib/RemoteDaemonRunner.js
	 */
	private getRunnerPath(): string {
		// Get the directory of the current file (bundled in dist/)
		const currentFilePath = fileURLToPath(import.meta.url)
		const currentDir = path.dirname(currentFilePath)

		// The runner is in the lib subdirectory
		return path.join(currentDir, 'lib', 'RemoteDaemonRunner.js')
	}
}
