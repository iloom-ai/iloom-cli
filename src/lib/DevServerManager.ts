import { execa, type ExecaChildProcess } from 'execa'
import { setTimeout } from 'timers/promises'
import { ProcessManager } from './process/ProcessManager.js'
import { buildDevServerCommand, detectAngularProject } from '../utils/dev-server.js'
import { runScript } from '../utils/package-manager.js'
import { getPackageScripts } from '../utils/package-json.js'
import { logger } from '../utils/logger.js'
import { createNgShim, type NgShimResult } from '../utils/ng-shim.js'

/**
 * Default startup timeout in milliseconds (180 seconds)
 * Can be overridden via ILOOM_DEV_SERVER_TIMEOUT environment variable
 */
const DEFAULT_STARTUP_TIMEOUT = 180000

function getStartupTimeout(): number {
	const envTimeout = process.env.ILOOM_DEV_SERVER_TIMEOUT
	if (envTimeout) {
		const parsed = parseInt(envTimeout, 10)
		if (!isNaN(parsed) && parsed > 0) {
			return parsed
		}
	}
	return DEFAULT_STARTUP_TIMEOUT
}

export interface DevServerManagerOptions {
	/**
	 * Maximum time to wait for server to start (in milliseconds)
	 * Default: 180000 (180 seconds)
	 * Can be overridden via ILOOM_DEV_SERVER_TIMEOUT environment variable
	 */
	startupTimeout?: number

	/**
	 * Interval between port checks (in milliseconds)
	 * Default: 1000 (1 second)
	 */
	checkInterval?: number

	/**
	 * CLI flag to pass port (e.g., '--port'). Auto-detected for Angular if not provided.
	 */
	portFlag?: string
}

/**
 * DevServerManager handles auto-starting and monitoring dev servers
 * Used by open/run commands to ensure dev server is running before opening browser
 */
export class DevServerManager {
	private readonly processManager: ProcessManager
	private readonly options: Required<Pick<DevServerManagerOptions, 'startupTimeout' | 'checkInterval'>> & { portFlag: string | undefined }
	private runningServers: Map<number, ExecaChildProcess> = new Map()
	private shimCleanups: Array<() => Promise<void>> = []

	constructor(
		processManager?: ProcessManager,
		options: DevServerManagerOptions = {}
	) {
		this.processManager = processManager ?? new ProcessManager()
		this.options = {
			startupTimeout: options.startupTimeout ?? getStartupTimeout(),
			checkInterval: options.checkInterval ?? 1000,
			portFlag: options.portFlag,
		}
	}

	/**
	 * Ensure dev server is running on the specified port
	 * If not running, start it and wait for it to be ready
	 *
	 * @param worktreePath - Path to the worktree
	 * @param port - Port the server should run on
	 * @returns true if server is ready, false if startup failed/timed out
	 */
	async ensureServerRunning(worktreePath: string, port: number): Promise<boolean> {
		logger.debug(`Checking if dev server is running on port ${port}...`)

		// Check if already running
		const existingProcess = await this.processManager.detectDevServer(port)
		if (existingProcess) {
			logger.debug(
				`Dev server already running on port ${port} (PID: ${existingProcess.pid})`
			)
			return true
		}

		// Not running - start it
		logger.info(`Dev server not running on port ${port}, starting...`)

		try {
			await this.startDevServer(worktreePath, port)
			return true
		} catch (error) {
			logger.error(
				`Failed to start dev server: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
			return false
		}
	}

	/**
	 * Start dev server in background and wait for it to be ready
	 */
	private async startDevServer(worktreePath: string, port: number): Promise<void> {
		// Guard: Check if a dev script exists in package.json or package.iloom.json
		const scripts = await getPackageScripts(worktreePath)
		if (!scripts['dev']) {
			logger.warn('Skipping auto-start: no "dev" script found in package.json or package.iloom.json')
			return
		}

		// Build dev server command with port flag support
		const devCommand = await buildDevServerCommand(worktreePath, {
			port,
			...(this.options.portFlag !== undefined && { portFlag: this.options.portFlag }),
		})
		logger.debug(`Starting dev server with command: ${devCommand}`)

		// Start server in background
		const serverProcess = execa('sh', ['-c', devCommand], {
			cwd: worktreePath,
			env: {
				...process.env,
				PORT: port.toString(),
			},
			// Important: Don't inherit stdio - server runs in background
			stdio: 'ignore',
			// Detach from parent process so it continues running
			detached: true,
		})

		// Store reference to prevent cleanup
		this.runningServers.set(port, serverProcess)

		// Unref so parent can exit
		serverProcess.unref()

		// Wait for server to be ready
		logger.info(`Waiting for dev server to start on port ${port}...`)
		const ready = await this.waitForServerReady(port)

		if (!ready) {
			throw new Error(
				`Dev server failed to start within ${this.options.startupTimeout}ms timeout`
			)
		}

		logger.success(`Dev server started successfully on port ${port}`)
	}

	/**
	 * Wait for server to be ready by polling the port
	 */
	private async waitForServerReady(port: number): Promise<boolean> {
		const startTime = Date.now()
		let attempts = 0

		while (Date.now() - startTime < this.options.startupTimeout) {
			attempts++

			// Check if server is listening
			const processInfo = await this.processManager.detectDevServer(port)

			if (processInfo) {
				logger.debug(
					`Server detected on port ${port} after ${attempts} attempts (${Date.now() - startTime}ms)`
				)
				return true
			}

			// Wait before next check
			await setTimeout(this.options.checkInterval)
		}

		// Timeout
		logger.warn(
			`Server did not start on port ${port} after ${this.options.startupTimeout}ms (${attempts} attempts)`
		)
		return false
	}

	/**
	 * Check if a dev server is running on the specified port
	 *
	 * @param port - Port to check
	 * @returns true if server is running, false otherwise
	 */
	async isServerRunning(port: number): Promise<boolean> {
		const existingProcess = await this.processManager.detectDevServer(port)
		return existingProcess !== null
	}

	/**
	 * Get the effective port flag, using explicit config or auto-detecting for Angular projects
	 * @param worktreePath - Path to check for Angular project
	 * @returns The port flag to use, or undefined if none
	 */
	private async getEffectivePortFlag(worktreePath: string): Promise<string | undefined> {
		// Explicit config takes precedence (including empty string for opt-out)
		if (this.options.portFlag !== undefined) {
			return this.options.portFlag || undefined // Convert empty string to undefined (opt-out)
		}
		// Auto-detect Angular projects
		if (await detectAngularProject(worktreePath)) {
			return '--port'
		}
		return undefined
	}

	/**
	 * Run dev server in foreground mode (blocking)
	 * This method blocks until the server is stopped (e.g., via Ctrl+C)
	 *
	 * @param worktreePath - Path to the worktree
	 * @param port - Port the server should run on
	 * @param redirectToStderr - If true, redirect stdout/stderr to stderr (useful for JSON output)
	 * @param onProcessStarted - Callback called immediately after process starts with PID
	 * @returns Process information including PID
	 */
	async runServerForeground(
		worktreePath: string,
		port: number,
		redirectToStderr = false,
		onProcessStarted?: (pid?: number) => void,
		envOverrides?: Record<string, string>
	): Promise<{ pid?: number }> {
		logger.debug(`Starting dev server in foreground on port ${port}`)

		// Use runScript for foreground mode to support multi-language projects
		// Note: redirectToStderr is handled via custom execa call when needed
		if (redirectToStderr) {
			// For redirectToStderr, we still need direct execa control for custom stdio
			const devCommand = await buildDevServerCommand(worktreePath, {
				port,
				...(this.options.portFlag !== undefined && { portFlag: this.options.portFlag }),
			})
			logger.debug(`Starting dev server with command: ${devCommand}`)

			const serverProcess = execa('sh', ['-c', devCommand], {
				cwd: worktreePath,
				env: {
					...process.env,
					...envOverrides,
					PORT: port.toString(),
				},
				stdio: [process.stdin, process.stderr, process.stderr],
			})

			const processInfo: { pid?: number } = serverProcess.pid !== undefined ? { pid: serverProcess.pid } : {}

			if (onProcessStarted) {
				onProcessStarted(processInfo.pid)
			}

			await serverProcess
			return processInfo
		}

		// Check if we should use the PATH shim approach for Angular
		// PATH shim is used when:
		// 1. No explicit portFlag is configured (auto-detection mode)
		// 2. Angular project is detected
		const usePathShim = this.options.portFlag === undefined && await detectAngularProject(worktreePath)

		let ngShim: NgShimResult | undefined
		let shimEnv: Record<string, string> = {}

		if (usePathShim) {
			logger.debug('Angular project detected, using PATH shim for port injection')
			ngShim = await createNgShim(port, worktreePath)
			this.shimCleanups.push(ngShim.cleanup)

			// Prepend shim directory to PATH and set environment variables for the shim
			const currentPath = process.env.PATH ?? ''
			shimEnv = {
				PATH: `${ngShim.shimDir}:${currentPath}`,
				ILOOM_WORKSPACE_PATH: worktreePath,
				ILOOM_TARGET_PORT: port.toString(),
				// Suppress Angular CLI interactive prompts (autocompletion setup, analytics, etc.)
				NG_CLI_ANALYTICS: 'ci',
			}
			logger.info(`[DEBUG] Shim dir: ${ngShim.shimDir}`)
			logger.info(`[DEBUG] PATH starts with: ${shimEnv.PATH?.substring(0, 200)}...`)
		}

		// Build args array for port flag (for non-Angular projects with explicit portFlag)
		const portFlagArgs: string[] = []
		if (!usePathShim) {
			const effectivePortFlag = await this.getEffectivePortFlag(worktreePath)
			if (effectivePortFlag) {
				portFlagArgs.push('--', `${effectivePortFlag}=${port}`)
			}
		}

		try {
			// Use runScript for standard foreground mode
			return await runScript('dev', worktreePath, portFlagArgs, {
				env: {
					...shimEnv,
					...envOverrides,
					PORT: port.toString(),
				},
				foreground: true,
				...(onProcessStarted && { onStart: onProcessStarted }),
				noCi: true, // Dev servers should not have CI=true
			})
		} finally {
			// Clean up the shim when the process exits
			if (ngShim) {
				await ngShim.cleanup()
				// Remove from cleanup list since we've already cleaned up
				const index = this.shimCleanups.indexOf(ngShim.cleanup)
				if (index !== -1) {
					this.shimCleanups.splice(index, 1)
				}
			}
		}
	}

	/**
	 * Clean up all running server processes and shim directories
	 * This should be called when the manager is being disposed
	 */
	async cleanup(): Promise<void> {
		// Clean up running servers
		for (const [port, serverProcess] of this.runningServers.entries()) {
			try {
				logger.debug(`Cleaning up server process on port ${port}`)
				serverProcess.kill()
			} catch (error) {
				logger.warn(
					`Failed to kill server process on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		}
		this.runningServers.clear()

		// Clean up any remaining shim directories
		for (const cleanupFn of this.shimCleanups) {
			try {
				await cleanupFn()
			} catch (error) {
				logger.warn(
					`Failed to cleanup shim directory: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		}
		this.shimCleanups = []
	}
}
