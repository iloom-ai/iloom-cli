import { execa, type ExecaChildProcess, type ExecaError } from 'execa'
import { setTimeout } from 'timers/promises'
import { ProcessManager } from './process/ProcessManager.js'
import { buildDevServerCommand } from '../utils/dev-server.js'
import { runScript } from '../utils/package-manager.js'
import { getPackageScripts } from '../utils/package-json.js'
import { logger } from '../utils/logger.js'
import { restoreTerminalState } from '../utils/terminal.js'
import type { DevServerStrategy, ForegroundOpts } from './DevServerStrategy.js'

/**
 * NativeDevServerStrategy implements DevServerStrategy for process-based dev servers.
 * This is the default mode — the dev server runs directly on the host as a child process.
 */
export class NativeDevServerStrategy implements DevServerStrategy {
	private readonly processManager: ProcessManager
	private readonly startupTimeout: number
	private readonly checkInterval: number
	private runningServers: Map<number, ExecaChildProcess> = new Map()

	constructor(
		processManager: ProcessManager,
		startupTimeout: number,
		checkInterval: number
	) {
		this.processManager = processManager
		this.startupTimeout = startupTimeout
		this.checkInterval = checkInterval
	}

	async isRunning(port: number): Promise<boolean> {
		const process = await this.processManager.detectDevServer(port)
		return process !== null
	}

	async startBackground(
		worktreePath: string,
		port: number,
		envOverrides?: Record<string, string>
	): Promise<void> {
		// Guard: Check if a dev script exists in package.json or package.iloom.json
		const scripts = await getPackageScripts(worktreePath)
		if (!scripts['dev']) {
			logger.warn('Skipping auto-start: no "dev" script found in package.json or package.iloom.json')
			return
		}

		// Build dev server command
		const devCommand = await buildDevServerCommand(worktreePath)
		logger.debug(`Starting dev server with command: ${devCommand}`)

		// Start server in background
		const serverProcess = execa('sh', ['-c', devCommand], {
			cwd: worktreePath,
			env: {
				...process.env,
				...envOverrides,
				PORT: port.toString(),
			},
			// Important: Don't inherit stdio - server runs in background
			stdio: 'ignore',
			// Detach from parent process so it continues running
			detached: true,
		})

		// Store reference to prevent cleanup
		this.runningServers.set(port, serverProcess)

		// Remove from map when process exits naturally or crashes
		serverProcess.on('exit', () => {
			this.runningServers.delete(port)
		})

		// Unref so parent can exit
		serverProcess.unref()

		// Wait for server to be ready (pass process ref for early crash detection)
		logger.info(`Waiting for dev server to start on port ${port}...`)
		const ready = await this.waitForReady(port, serverProcess)

		if (!ready) {
			throw new Error(
				`Dev server failed to start within ${this.startupTimeout}ms timeout`
			)
		}

		logger.success(`Dev server started successfully on port ${port}`)
	}

	async startForeground(
		worktreePath: string,
		port: number,
		opts: ForegroundOpts
	): Promise<{ pid?: number }> {
		const { redirectToStderr = false, onProcessStarted, envOverrides } = opts

		logger.debug(`Starting dev server in foreground on port ${port}`)

		if (redirectToStderr) {
			// For redirectToStderr, we need direct execa control for custom stdio
			const devCommand = await buildDevServerCommand(worktreePath)
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

			const processInfo: { pid?: number } =
				serverProcess.pid !== undefined ? { pid: serverProcess.pid } : {}

			if (onProcessStarted) {
				onProcessStarted(processInfo.pid)
			}

			// Register no-op SIGINT handler to prevent signal-exit from re-raising SIGINT
			// before finally blocks can run, ensuring terminal state is restored on Ctrl+C.
			const onSigint = (): void => {}
			process.on('SIGINT', onSigint)

			try {
				await serverProcess
			} catch (error) {
				const execaError = error as ExecaError
				// If killed by SIGINT, the user intentionally cancelled — return silently
				if (execaError.signal !== 'SIGINT') {
					throw error
				}
			} finally {
				process.removeListener('SIGINT', onSigint)
				restoreTerminalState()
			}

			return processInfo
		}

		// Use runScript for standard foreground mode
		return await runScript('dev', worktreePath, [], {
			env: {
				...envOverrides,
				PORT: port.toString(),
			},
			foreground: true,
			...(onProcessStarted && { onStart: onProcessStarted }),
			noCi: true, // Dev servers should not have CI=true
		})
	}

	async stop(port: number): Promise<boolean> {
		const serverProcess = this.runningServers.get(port)
		if (!serverProcess) {
			return false
		}

		try {
			// Kill the entire process group (negative PID) since the server is
			// spawned with detached:true via `sh -c`. Without this, only the
			// shell process receives the signal and the actual dev server
			// (node/vite/next) remains running as an orphan.
			if (serverProcess.pid) {
				process.kill(-serverProcess.pid, 'SIGTERM')
			} else {
				serverProcess.kill()
			}
			this.runningServers.delete(port)
			return true
		} catch (error) {
			logger.warn(
				`Failed to kill server process on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
			return false
		}
	}

	/**
	 * Stop all tracked server processes. Called during cleanup.
	 */
	async stopAll(): Promise<void> {
		for (const [port] of this.runningServers.entries()) {
			await this.stop(port)
		}
	}

	/**
	 * Wait for server to be ready by polling the port.
	 * Exits early if the spawned process has already exited (crash detection).
	 * Public so DevServerManager can reuse it for Docker mode readiness checks.
	 *
	 * @param port - Port to poll
	 * @param processRef - Optional spawned process to monitor for early exit
	 */
	async waitForReady(port: number, processRef?: ExecaChildProcess): Promise<boolean> {
		const startTime = Date.now()
		let attempts = 0

		while (Date.now() - startTime < this.startupTimeout) {
			attempts++

			// Early exit: if the spawned process has already exited, stop polling
			// Check both null and undefined since exitCode is undefined before the process exits
			if (processRef && processRef.exitCode != null) {
				logger.warn(
					`Dev server process exited with code ${processRef.exitCode} before becoming ready (after ${attempts} attempts, ${Date.now() - startTime}ms)`
				)
				return false
			}

			const processInfo = await this.processManager.detectDevServer(port)

			if (processInfo) {
				logger.debug(
					`Server detected on port ${port} after ${attempts} attempts (${Date.now() - startTime}ms)`
				)
				return true
			}

			await setTimeout(this.checkInterval)
		}

		logger.warn(
			`Server did not start on port ${port} after ${this.startupTimeout}ms (${attempts} attempts)`
		)
		return false
	}
}
