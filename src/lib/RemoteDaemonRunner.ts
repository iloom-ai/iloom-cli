/**
 * RemoteDaemonRunner: Entry point for the daemon child process
 *
 * This module is executed as a forked child process by RemoteDaemonManager.
 * It runs the polling loop that periodically checks GitHub for closed/merged PRs
 * and triggers cleanup of corresponding local looms.
 *
 * The daemon receives configuration via:
 * - argv[2]: polling interval in seconds
 * - Environment variables:
 *   - ILOOM_DAEMON_LOG_FILE: Path to log file
 *   - ILOOM_DAEMON_STATUS_FILE: Path to status file
 */

import fs from 'fs-extra'
import { z } from 'zod'
import { GitHubPRPollingManager } from './GitHubPRPollingManager.js'
import type { PollResult } from '../types/remote.js'

/**
 * Default polling interval in seconds
 */
const DEFAULT_INTERVAL = 300

/**
 * Minimum polling interval in seconds (1 minute)
 */
const MIN_INTERVAL = 60

/**
 * Maximum polling interval in seconds (1 hour)
 */
const MAX_INTERVAL = 3600

/**
 * Maximum log file size in bytes before rotation (5MB)
 */
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024

/**
 * Zod schema for runtime config validation
 * This ensures configuration cannot bypass the 60s minimum interval
 */
const DaemonRuntimeConfigSchema = z.object({
	interval: z
		.number()
		.int('Polling interval must be an integer')
		.min(MIN_INTERVAL, `Polling interval must be at least ${MIN_INTERVAL} seconds`)
		.max(MAX_INTERVAL, `Polling interval must be at most ${MAX_INTERVAL} seconds`),
	logFile: z.string().min(1, 'Log file path is required'),
	statusFile: z.string().min(1, 'Status file path is required'),
})

type DaemonRuntimeConfig = z.infer<typeof DaemonRuntimeConfigSchema>

/**
 * Flag to indicate shutdown has been requested
 */
let shutdownRequested = false

/**
 * Format a date for logging
 */
function formatTimestamp(): string {
	return new Date().toISOString()
}

/**
 * Sanitize error messages before logging to prevent information disclosure.
 * Removes potentially sensitive information like absolute paths, credentials,
 * and internal stack trace details while preserving useful error context.
 *
 * SECURITY: Truncation happens FIRST to prevent ReDoS attacks from massive error messages.
 *
 * @param message - Raw error message
 * @returns Sanitized message safe for logging
 */
function sanitizeErrorMessage(message: string): string {
	// SECURITY: Truncate FIRST before any regex processing to prevent ReDoS attacks
	// This ensures attackers cannot craft massive inputs to cause exponential regex backtracking
	const maxLength = 1000
	let sanitized = message.length > maxLength
		? message.substring(0, maxLength) + '... (truncated)'
		: message

	// Remove absolute paths - Unix style (keep only filename)
	sanitized = sanitized.replace(/\/[^\s:]+\/([^/\s:]+)/g, '<path>/$1')

	// Remove absolute paths - Windows style (e.g., C:\Users\... or D:\path\to\file)
	sanitized = sanitized.replace(/[A-Za-z]:\\[^\s:]+\\([^\\s:]+)/g, '<path>\\$1')

	// Remove potential credentials/tokens (common patterns)
	sanitized = sanitized.replace(/token[=:]\s*['"]?[^\s'"]+['"]?/gi, 'token=<redacted>')
	sanitized = sanitized.replace(/api[_-]?key[=:]\s*['"]?[^\s'"]+['"]?/gi, 'api_key=<redacted>')
	sanitized = sanitized.replace(/password[=:]\s*['"]?[^\s'"]+['"]?/gi, 'password=<redacted>')
	sanitized = sanitized.replace(/secret[=:]\s*['"]?[^\s'"]+['"]?/gi, 'secret=<redacted>')

	// Remove environment variable values that might contain secrets
	sanitized = sanitized.replace(/\bghp_[a-zA-Z0-9_]+/g, '<github-token>')
	sanitized = sanitized.replace(/\bgho_[a-zA-Z0-9_]+/g, '<github-token>')
	sanitized = sanitized.replace(/\bghu_[a-zA-Z0-9_]+/g, '<github-token>')

	return sanitized
}

/**
 * Rotate the log file if it exceeds the maximum size.
 * Keeps one backup (.1) and discards older logs.
 *
 * @param logFile - Path to the log file
 */
async function rotateLogFileIfNeeded(logFile: string): Promise<void> {
	try {
		const exists = await fs.pathExists(logFile)
		if (!exists) {
			return
		}

		const stats = await fs.stat(logFile)
		if (stats.size < MAX_LOG_FILE_SIZE) {
			return
		}

		// Rotate: remove old backup, move current to .1, start fresh
		const backupPath = `${logFile}.1`
		try {
			await fs.remove(backupPath)
		} catch {
			// Ignore if backup doesn't exist
		}
		await fs.move(logFile, backupPath)
		await fs.writeFile(logFile, '', { mode: 0o644 })
	} catch {
		// Log rotation failure is not critical - continue with potentially large log
	}
}

/**
 * Append a message to the log file
 *
 * @param logFile - Path to the log file
 * @param level - Log level (INFO, WARN, ERROR, DEBUG)
 * @param message - Message to log
 */
async function appendLog(logFile: string, level: string, message: string): Promise<void> {
	const timestamp = formatTimestamp()

	// Sanitize error messages to prevent information disclosure
	const safeMessage = level === 'ERROR' || level === 'WARN' ? sanitizeErrorMessage(message) : message
	const logLine = `[${timestamp}] [${level}] ${safeMessage}\n`

	try {
		// Check if log rotation is needed before appending
		await rotateLogFileIfNeeded(logFile)
		await fs.appendFile(logFile, logLine)
	} catch {
		// If logging fails, write to stderr as fallback
		process.stderr.write(`Failed to write to log file: ${logLine}`)
	}
}

/**
 * Daemon logger interface
 */
interface DaemonLogger {
	info: (message: string) => Promise<void>
	warn: (message: string) => Promise<void>
	error: (message: string) => Promise<void>
	debug: (message: string) => Promise<void>
}

/**
 * Create a logger that writes to the daemon log file
 */
function createDaemonLogger(logFile: string): DaemonLogger {
	return {
		info: (message: string): Promise<void> => appendLog(logFile, 'INFO', message),
		warn: (message: string): Promise<void> => appendLog(logFile, 'WARN', message),
		error: (message: string): Promise<void> => appendLog(logFile, 'ERROR', message),
		debug: (message: string): Promise<void> => appendLog(logFile, 'DEBUG', message),
	}
}

/**
 * Update the status file with current daemon state
 *
 * @param statusFile - Path to the status file
 * @param pollResult - Result from the last poll cycle
 * @param monitoredLooms - Number of looms being monitored
 */
async function updateStatusFile(
	statusFile: string,
	pollResult: PollResult | null,
	monitoredLooms: number
): Promise<void> {
	const status = {
		lastPoll: new Date().toISOString(),
		monitoredLooms,
		lastPollResult: pollResult,
	}

	try {
		await fs.writeFile(statusFile, JSON.stringify(status, null, 2), { mode: 0o644 })
	} catch {
		// Status file update failure is not critical
	}
}

/**
 * Sleep for the specified number of milliseconds
 * Returns early if shutdown is requested
 *
 * @param ms - Milliseconds to sleep
 * @returns true if sleep completed, false if interrupted by shutdown
 */
async function interruptibleSleep(ms: number): Promise<boolean> {
	const checkInterval = 1000 // Check every second
	const iterations = Math.ceil(ms / checkInterval)

	for (let i = 0; i < iterations; i++) {
		if (shutdownRequested) {
			return false
		}
		await new Promise(resolve => globalThis.setTimeout(resolve, Math.min(checkInterval, ms - i * checkInterval)))
	}

	return !shutdownRequested
}

/**
 * Format a PollResult for human-readable logging
 */
function formatPollResult(result: PollResult): string {
	const parts: string[] = []

	// Describe what was monitored (show PR identifiers if < 5)
	if (result.checked === 0) {
		parts.push('No active looms with PRs to monitor')
	} else if (result.checked < 5 && result.monitoredPRs && result.monitoredPRs.length > 0) {
		// Show specific PRs when there are few
		parts.push(`Monitoring ${result.monitoredPRs.join(', ')}`)
	} else {
		parts.push(`Monitored ${result.checked} PR${result.checked === 1 ? '' : 's'}`)
	}

	// Describe cleanups if any
	if (result.cleaned > 0) {
		parts.push(`cleaned up ${result.cleaned} loom${result.cleaned === 1 ? '' : 's'}`)
	}

	// Describe skips if any (looms with uncommitted changes)
	if (result.skipped > 0) {
		parts.push(`skipped ${result.skipped} (uncommitted changes)`)
	}

	// Describe errors if any
	if (result.errors.length > 0) {
		parts.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`)
	}

	// If nothing happened except monitoring, say so
	if (result.checked > 0 && result.cleaned === 0 && result.skipped === 0 && result.errors.length === 0) {
		parts.push('all PRs still open')
	}

	return parts.join(', ')
}

/**
 * Run the polling loop
 *
 * @param intervalSeconds - Polling interval in seconds
 * @param logFile - Path to log file
 * @param statusFile - Path to status file
 */
async function runPollingLoop(
	intervalSeconds: number,
	logFile: string,
	statusFile: string
): Promise<void> {
	const logger = createDaemonLogger(logFile)
	const pollingManager = new GitHubPRPollingManager()

	await logger.info(`Daemon started with polling interval of ${intervalSeconds} seconds`)

	while (!shutdownRequested) {
		try {
			await logger.debug('Starting poll cycle')

			const result = await pollingManager.pollAndCleanup()

			await logger.info(`Poll completed: ${formatPollResult(result)}`)

			// Log any errors from the poll
			for (const error of result.errors) {
				await logger.warn(`Poll error: ${error}`)
			}

			// Update status file
			await updateStatusFile(statusFile, result, result.checked)
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			await logger.error(`Poll cycle failed: ${errorMsg}`)
			await updateStatusFile(statusFile, null, 0)
		}

		// Sleep for the interval, checking for shutdown periodically
		const sleepMs = intervalSeconds * 1000
		const completed = await interruptibleSleep(sleepMs)

		if (!completed) {
			await logger.info('Sleep interrupted by shutdown signal')
		}
	}

	await logger.info('Daemon shutting down gracefully')
}

/**
 * Set up signal handlers for graceful shutdown
 */
function setupSignalHandlers(logFile: string): void {
	const logger = createDaemonLogger(logFile)

	const handleShutdown = async (signal: string): Promise<void> => {
		if (shutdownRequested) {
			// Already shutting down, force exit
			process.exit(1)
		}

		await logger.info(`Received ${signal}, initiating graceful shutdown`)
		shutdownRequested = true
	}

	process.on('SIGTERM', () => void handleShutdown('SIGTERM'))
	process.on('SIGINT', () => void handleShutdown('SIGINT'))

	// Handle uncaught exceptions
	process.on('uncaughtException', async (error) => {
		await logger.error(`Uncaught exception: ${error.message}`)
		await logger.error(error.stack ?? 'No stack trace')
		process.exit(1)
	})

	// Handle unhandled promise rejections
	process.on('unhandledRejection', async (reason) => {
		const message = reason instanceof Error ? reason.message : String(reason)
		await logger.error(`Unhandled rejection: ${message}`)
		process.exit(1)
	})
}

/**
 * Parse and validate command line arguments using Zod schema.
 * This provides runtime validation to prevent bypassing the 60s minimum interval
 * through environment manipulation or argument tampering.
 *
 * @returns Validated configuration
 * @throws Error if configuration is invalid
 */
function parseArgs(): DaemonRuntimeConfig {
	// Parse interval from argv[2]
	const intervalArg = process.argv[2]
	let interval = DEFAULT_INTERVAL

	if (intervalArg) {
		const parsed = parseInt(intervalArg, 10)
		if (!isNaN(parsed)) {
			interval = parsed
		}
	}

	// Get file paths from environment variables
	const logFile = process.env['ILOOM_DAEMON_LOG_FILE'] ?? ''
	const statusFile = process.env['ILOOM_DAEMON_STATUS_FILE'] ?? ''

	// Validate using Zod schema - this enforces the 60s minimum even if
	// someone tries to bypass it by manipulating arguments directly
	const config = { interval, logFile, statusFile }
	const result = DaemonRuntimeConfigSchema.safeParse(config)

	if (!result.success) {
		const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
		throw new Error(`Invalid daemon configuration: ${errors}`)
	}

	return result.data
}

/**
 * Main entry point for the daemon runner
 */
async function main(): Promise<void> {
	try {
		const { interval, logFile, statusFile } = parseArgs()

		// Set up signal handlers first
		setupSignalHandlers(logFile)

		// Run the polling loop
		await runPollingLoop(interval, logFile, statusFile)

		// Clean exit
		process.exit(0)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`Daemon startup failed: ${message}\n`)
		process.exit(1)
	}
}

// Run main when this module is executed directly (not when imported)
// Check if this is the main module using import.meta.url
const isMainModule = process.argv[1]?.includes('RemoteDaemonRunner')

if (isMainModule) {
	void main()
}
