import path from 'path'
import { ProcessManager } from './process/ProcessManager.js'
import { DockerManager, type DockerConfig } from './DockerManager.js'
import { DockerDevServerStrategy, type DockerConfig as StrategyDockerConfig, type DockerUtils } from './DockerDevServerStrategy.js'
import { NativeDevServerStrategy } from './NativeDevServerStrategy.js'
import { logger } from '../utils/logger.js'

/**
 * Default startup timeout in milliseconds (180 seconds)
 * Can be overridden via ILOOM_DEV_SERVER_TIMEOUT environment variable
 */
const DEFAULT_STARTUP_TIMEOUT = 180000

/**
 * Bridge DockerManager static methods to the DockerUtils interface
 * expected by DockerDevServerStrategy.
 */
const dockerUtils: DockerUtils = {
	parseDockerfileExpose: (filePath: string) => DockerManager.parseExposeFromDockerfile(filePath),
	inspectImagePorts: (imageName: string) => DockerManager.inspectImagePorts(imageName),
	buildContainerName: (id: string | number) => DockerManager.buildContainerName(id),
	buildImageName: (id: string | number) => DockerManager.buildImageName(id),
	assertDockerAvailable: () => DockerManager.assertAvailable(),
}

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
}

// Re-export DockerConfig from DockerManager for backward compatibility
export type { DockerConfig } from './DockerManager.js'

/**
 * Convert a DockerConfig (from DockerManager) to a StrategyDockerConfig
 * (for DockerDevServerStrategy).
 */
function toStrategyConfig(config: DockerConfig): StrategyDockerConfig {
	return {
		dockerFile: config.dockerFile,
		containerPort: config.containerPort,
		buildArgs: config.dockerBuildArgs,
		buildSecrets: config.dockerBuildSecrets,
		runArgs: config.dockerRunArgs,
		identifier: config.identifier,
		protocol: config.protocol,
	}
}

/**
 * DevServerManager handles auto-starting and monitoring dev servers.
 * Used by open/run commands to ensure dev server is running before opening browser.
 *
 * When devServer config is absent OR mode is not 'docker', behavior is identical
 * to the native process-based implementation via NativeDevServerStrategy.
 * When Docker mode is configured, all operations delegate to DockerDevServerStrategy.
 */
export class DevServerManager {
	private readonly processManager: ProcessManager
	private readonly options: Required<DevServerManagerOptions>
	private readonly nativeStrategy: NativeDevServerStrategy
	private runningDockerContainers: Map<number, string> = new Map()

	constructor(
		processManager?: ProcessManager,
		options: DevServerManagerOptions = {}
	) {
		this.processManager = processManager ?? new ProcessManager()
		this.options = {
			startupTimeout: options.startupTimeout ?? getStartupTimeout(),
			checkInterval: options.checkInterval ?? 1000,
		}
		this.nativeStrategy = new NativeDevServerStrategy(
			this.processManager,
			this.options.startupTimeout,
			this.options.checkInterval
		)
	}

	/**
	 * Create a DockerDevServerStrategy for the given Docker config.
	 * The strategy encapsulates all Docker container lifecycle operations.
	 */
	private createDockerStrategy(dockerConfig: DockerConfig): DockerDevServerStrategy {
		return new DockerDevServerStrategy(toStrategyConfig(dockerConfig), dockerUtils)
	}

	/**
	 * Ensure dev server is running on the specified port.
	 * If not running, start it and wait for it to be ready.
	 *
	 * @param worktreePath - Path to the worktree
	 * @param port - Port the server should run on
	 * @param dockerConfig - Optional Docker configuration for container-based server
	 * @returns true if server is ready, false if startup failed/timed out
	 */
	async ensureServerRunning(worktreePath: string, port: number, dockerConfig?: DockerConfig): Promise<boolean> {
		logger.debug(`Checking if dev server is running on port ${port}...`)

		// Docker mode: check if container is already running
		if (dockerConfig) {
			const strategy = this.createDockerStrategy(dockerConfig)
			const containerName = dockerUtils.buildContainerName(dockerConfig.identifier)
			const isRunning = await strategy.isContainerRunning(containerName)
			if (isRunning) {
				logger.debug(`Docker container "${containerName}" already running on port ${port}`)
				return true
			}

			logger.info(`Docker dev server not running on port ${port}, starting...`)
			try {
				await this.startDockerServer(worktreePath, port, dockerConfig, strategy)
				return true
			} catch (error) {
				logger.error(
					`Failed to start Docker dev server: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
				return false
			}
		}

		// Native mode: check if a process is listening on the port
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
			await this.nativeStrategy.startBackground(worktreePath, port)
			return true
		} catch (error) {
			logger.error(
				`Failed to start dev server: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
			return false
		}
	}

	/**
	 * Start dev server in Docker container (background) and wait for it to be ready.
	 * Builds the image, resolves the container port, starts the container detached,
	 * and polls the host port for readiness.
	 */
	private async startDockerServer(
		worktreePath: string,
		port: number,
		dockerConfig: DockerConfig,
		strategy: DockerDevServerStrategy
	): Promise<void> {
		const strategyConfig = toStrategyConfig(dockerConfig)
		const imageName = dockerUtils.buildImageName(dockerConfig.identifier)
		const dockerfilePath = path.resolve(worktreePath, dockerConfig.dockerFile)

		// Build image
		await strategy.buildImage(worktreePath, strategyConfig)

		// Resolve container port (config > image inspect > Dockerfile EXPOSE)
		const containerPort = await strategy.resolveContainerPort(
			strategyConfig,
			imageName,
			dockerfilePath
		)

		// Run container detached
		const containerName = await strategy.runContainerDetached(
			worktreePath,
			port,
			containerPort,
			strategyConfig
		)

		// Track for cleanup
		this.runningDockerContainers.set(port, containerName)

		// Wait for server to be ready via TCP probe (Docker proxy listens on host port)
		// Pass container name for early crash detection
		logger.info(`Waiting for Docker dev server to start on port ${port}...`)
		const ready = await strategy.waitForReady(
			port,
			this.options.startupTimeout,
			this.options.checkInterval,
			containerName
		)

		if (!ready) {
			// Clean up the container if startup failed
			await strategy.stopContainer(containerName)
			this.runningDockerContainers.delete(port)
			throw new Error(
				`Docker dev server failed to start within ${this.options.startupTimeout}ms timeout`
			)
		}

		logger.success(`Docker dev server started successfully on port ${port}`)
	}

	/**
	 * Check if a dev server is running on the specified port
	 *
	 * @param port - Port to check
	 * @param dockerConfig - Optional Docker configuration; when provided, checks container status
	 * @returns true if server is running, false otherwise
	 */
	async isServerRunning(port: number, dockerConfig?: DockerConfig): Promise<boolean> {
		if (dockerConfig) {
			const strategy = this.createDockerStrategy(dockerConfig)
			const containerName = dockerUtils.buildContainerName(dockerConfig.identifier)
			return strategy.isContainerRunning(containerName)
		}
		const existingProcess = await this.processManager.detectDevServer(port)
		return existingProcess !== null
	}

	/**
	 * Run dev server in foreground mode (blocking).
	 * This method blocks until the server is stopped (e.g., via Ctrl+C).
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
		envOverrides?: Record<string, string>,
		dockerConfig?: DockerConfig,
		onOutput?: (data: Buffer) => void
	): Promise<{ pid?: number }> {
		// Docker mode: build image and run container in foreground
		if (dockerConfig) {
			logger.debug(`Starting Docker dev server in foreground on port ${port}`)

			const strategy = this.createDockerStrategy(dockerConfig)
			const strategyConfig = toStrategyConfig(dockerConfig)
			const imageName = dockerUtils.buildImageName(dockerConfig.identifier)
			const containerName = dockerUtils.buildContainerName(dockerConfig.identifier)
			const dockerfilePath = path.resolve(worktreePath, dockerConfig.dockerFile)

			// Build image
			await strategy.buildImage(worktreePath, strategyConfig)

			// Resolve container port
			const containerPort = await strategy.resolveContainerPort(
				strategyConfig,
				imageName,
				dockerfilePath
			)

			if (onProcessStarted) {
				onProcessStarted(undefined)
			}

			// Track container for cleanup
			this.runningDockerContainers.set(port, containerName)
			try {
				// Run container in foreground (blocks until stopped)
				// DockerDevServerStrategy.runContainerForeground handles signal forwarding internally
				await strategy.runContainerForeground(
					worktreePath,
					port,
					containerPort,
					strategyConfig,
					{ redirectToStderr, envOverrides, onOutput }
				)
			} finally {
				this.runningDockerContainers.delete(port)
			}

			return {}
		}

		// Native mode: delegate to NativeDevServerStrategy
		return this.nativeStrategy.startForeground(worktreePath, port, {
			redirectToStderr,
			...(onProcessStarted !== undefined && { onProcessStarted }),
			...(envOverrides !== undefined && { envOverrides }),
			...(onOutput !== undefined && { onOutput }),
		})
	}

	/**
	 * Clean up all running server processes and Docker containers.
	 * This should be called when the manager is being disposed.
	 */
	async cleanup(): Promise<void> {
		// Clean up native process-based servers
		await this.nativeStrategy.stopAll()

		// Clean up Docker containers using DockerDevServerStrategy
		for (const [port, containerName] of this.runningDockerContainers.entries()) {
			try {
				logger.debug(`Cleaning up Docker container "${containerName}" on port ${port}`)
				// Create a minimal strategy just for stopContainer
				const strategy = new DockerDevServerStrategy({}, dockerUtils)
				await strategy.stopContainer(containerName)
			} catch (error) {
				logger.warn(
					`Failed to stop Docker container "${containerName}" on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
		}
		this.runningDockerContainers.clear()
	}
}
