import { execa, type ExecaChildProcess, type ExecaError } from 'execa'
import { setTimeout } from 'timers/promises'
import { ProcessManager } from './process/ProcessManager.js'
import { logger } from '../utils/logger.js'
import { restoreTerminalState } from '../utils/terminal.js'
import type { DevServerStrategy, ForegroundOpts } from './DevServerStrategy.js'

/**
 * MetroDevServerStrategy implements DevServerStrategy for React Native's Metro bundler.
 * This strategy starts Metro via `npx react-native start --port <port>` and uses
 * ProcessManager for port-based detection and lifecycle management.
 *
 * Metro binds to a TCP port like any Node.js server, so ProcessManager.detectDevServer
 * works for readiness checks. The key difference from NativeDevServerStrategy is the
 * command used — Metro does not use package.json `dev` scripts.
 */
export class MetroDevServerStrategy implements DevServerStrategy {
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
		logger.debug(`Starting Metro bundler in background on port ${port}`)

		const serverProcess = execa('npx', ['react-native', 'start', '--port', port.toString()], {
			cwd: worktreePath,
			env: {
				...process.env,
				...envOverrides,
				PORT: port.toString(),
			},
			stdio: 'ignore',
			detached: true,
		})

		// Attach no-op catch to suppress unhandled promise rejection if the process
		// fails to spawn (e.g. npx not found). Actual errors are detected via waitForReady.
		serverProcess.catch((error: unknown) => {
			logger.debug(`Metro bundler process rejected: ${error instanceof Error ? error.message : 'Unknown error'}`)
		})

		this.runningServers.set(port, serverProcess)

		serverProcess.on('exit', () => {
			this.runningServers.delete(port)
		})

		serverProcess.unref()

		logger.info(`Waiting for Metro bundler to start on port ${port}...`)
		const ready = await this.waitForReady(port, serverProcess)

		if (!ready) {
			// Clean up the zombie process before throwing — it may still be running
			// and holding the port, causing subsequent attempts to fail with EADDRINUSE.
			await this.stop(port)
			throw new Error(
				`Metro bundler failed to start within ${this.startupTimeout}ms timeout`
			)
		}

		logger.success(`Metro bundler started successfully on port ${port}`)
	}

	async startForeground(
		worktreePath: string,
		port: number,
		opts: ForegroundOpts
	): Promise<{ pid?: number }> {
		const { redirectToStderr = false, onProcessStarted, envOverrides, onOutput } = opts

		logger.debug(`Starting Metro bundler in foreground on port ${port}`)

		const metroArgs = ['react-native', 'start', '--port', port.toString()]

		// Determine stdio based on mode
		const stdio = onOutput
			? (['ignore', 'pipe', 'pipe'] as const)
			: redirectToStderr
				? ([process.stdin, process.stderr, process.stderr] as const)
				: (['inherit', 'inherit', 'inherit'] as const)

		const serverProcess = execa('npx', metroArgs, {
			cwd: worktreePath,
			env: {
				...process.env,
				...envOverrides,
				PORT: port.toString(),
			},
			stdio,
		})

		// When onOutput is provided, pipe stdout/stderr to the callback
		if (onOutput) {
			serverProcess.stdout?.on('data', onOutput)
			serverProcess.stderr?.on('data', onOutput)
		}

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

	async stop(port: number): Promise<boolean> {
		const serverProcess = this.runningServers.get(port)
		if (!serverProcess) {
			return false
		}

		try {
			// Kill the entire process group (negative PID) since the server is
			// spawned with detached:true. Without this, only the npx process
			// receives the signal and the actual Metro bundler remains running.
			if (serverProcess.pid) {
				process.kill(-serverProcess.pid, 'SIGTERM')
			} else {
				serverProcess.kill()
			}
			this.runningServers.delete(port)
			return true
		} catch (error) {
			// ESRCH means the process already exited — not a real failure
			if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
				this.runningServers.delete(port)
				return true
			}
			logger.warn(
				`Failed to kill Metro bundler process on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
			return false
		}
	}

	/**
	 * Stop all tracked Metro bundler processes. Called during cleanup.
	 */
	async stopAll(): Promise<void> {
		for (const [port] of this.runningServers.entries()) {
			await this.stop(port)
		}
	}

	/**
	 * Wait for Metro bundler to be ready by polling the port.
	 * Exits early if the spawned process has already exited (crash detection).
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
			if (processRef && processRef.exitCode != null) {
				logger.warn(
					`Metro bundler process exited with code ${processRef.exitCode} before becoming ready (after ${attempts} attempts, ${Date.now() - startTime}ms)`
				)
				return false
			}

			const processInfo = await this.processManager.detectDevServer(port)

			if (processInfo) {
				logger.debug(
					`Metro bundler detected on port ${port} after ${attempts} attempts (${Date.now() - startTime}ms)`
				)
				return true
			}

			await setTimeout(this.checkInterval)
		}

		logger.warn(
			`Metro bundler did not start on port ${port} after ${this.startupTimeout}ms (${attempts} attempts)`
		)
		return false
	}
}
