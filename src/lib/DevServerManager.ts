import path from 'path'
import os from 'os'
import fs from 'fs/promises'
import { ProcessManager } from './process/ProcessManager.js'
import { DockerManager, type DockerConfig } from './DockerManager.js'
import { DockerDevServerStrategy, type DockerConfig as StrategyDockerConfig, type DockerUtils } from './DockerDevServerStrategy.js'
import { ComposeDevServerStrategy, findComposeFile, type ComposeUtils } from './ComposeDevServerStrategy.js'
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

/**
 * Ensure the compose override directory exists and return its path.
 * Located under the global iloom config dir to keep worktrees clean.
 */
async function getComposeOverrideDir(): Promise<string> {
	const dirPath = path.join(os.homedir(), '.config', 'iloom-ai', 'compose-overrides')
	await fs.mkdir(dirPath, { recursive: true })
	return dirPath
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

// Re-export compose types for callers that need them
export type { ComposeUtils } from './ComposeDevServerStrategy.js'

/**
 * Convert a DockerConfig (from DockerManager) to a StrategyDockerConfig
 * (for DockerDevServerStrategy).
 */
function toStrategyConfig(config: DockerConfig): StrategyDockerConfig {
	return {
		dockerFile: config.dockerFile,
		containerPort: config.containerPort,
		buildArgs: config.dockerBuildArgs,
		runArgs: config.dockerRunArgs,
		identifier: config.identifier,
	}
}

/**
 * DevServerManager handles auto-starting and monitoring dev servers.
 * Used by open/run commands to ensure dev server is running before opening browser.
 *
 * When devServer config is absent OR mode is not 'docker', behavior is identical
 * to the native process-based implementation via NativeDevServerStrategy.
 * When Docker mode is configured, auto-detects compose files (compose.yml,
 * docker-compose.yml). If a compose file is found, delegates to
 * ComposeDevServerStrategy; otherwise falls back to DockerDevServerStrategy.
 */
export class DevServerManager {
	private readonly processManager: ProcessManager
	private readonly options: Required<DevServerManagerOptions>
	private readonly nativeStrategy: NativeDevServerStrategy
	private readonly composeUtils: ComposeUtils
	private runningDockerContainers: Map<number, string> = new Map()
	/**
	 * Tracks running compose stacks: projectName -> { port, composeFile, overrideFile }
	 * Keyed by projectName (not port) to avoid overwrite collisions on retry.
	 */
	private runningComposeStacks: Map<string, { port: number; composeFile: string; overrideFile: string }> = new Map()

	constructor(
		processManager?: ProcessManager,
		options: DevServerManagerOptions = {},
		composeUtils?: ComposeUtils
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
		// Default compose utils will be replaced by real implementations once
		// the compose-file-parser module is merged (sibling issue).
		// For now, provide a placeholder that throws informative errors.
		this.composeUtils = composeUtils ?? {
			parseComposeFile: async (): Promise<never> => {
				throw new Error(
					'Compose file parsing is not yet available. ' +
					'The compose-file-parser module has not been merged.'
				)
			},
			generateOverrideFile: async (): Promise<never> => {
				throw new Error(
					'Compose override file generation is not yet available. ' +
					'The compose-file-parser module has not been merged.'
				)
			},
		}
	}

	/**
	 * Create a DockerDevServerStrategy for the given Docker config.
	 * The strategy encapsulates all Docker container lifecycle operations.
	 */
	private createDockerStrategy(dockerConfig: DockerConfig): DockerDevServerStrategy {
		return new DockerDevServerStrategy(toStrategyConfig(dockerConfig), dockerUtils)
	}

	/**
	 * Create a ComposeDevServerStrategy backed by the injected compose utils.
	 */
	private createComposeStrategy(): ComposeDevServerStrategy {
		return new ComposeDevServerStrategy(this.composeUtils)
	}

	/**
	 * Ensure dev server is running on the specified port.
	 * If not running, start it and wait for it to be ready.
	 *
	 * When dockerConfig is provided, auto-detects compose files in the worktree:
	 * - If a compose file exists, uses ComposeDevServerStrategy
	 * - Otherwise falls back to DockerDevServerStrategy (single Dockerfile)
	 *
	 * @param worktreePath - Path to the worktree
	 * @param port - Port the server should run on
	 * @param dockerConfig - Optional Docker configuration for container-based server
	 * @returns true if server is ready, false if startup failed/timed out
	 */
	async ensureServerRunning(worktreePath: string, port: number, dockerConfig?: DockerConfig): Promise<boolean> {
		logger.debug(`Checking if dev server is running on port ${port}...`)

		// Docker mode: auto-detect compose file vs. single Dockerfile
		if (dockerConfig) {
			const composeFile = await findComposeFile(worktreePath)

			if (composeFile) {
				// Compose mode
				const projectName = ComposeDevServerStrategy.buildProjectName(dockerConfig.identifier)
				const strategy = this.createComposeStrategy()
				const isRunning = await strategy.isStackRunning(projectName)
				if (isRunning) {
					logger.debug(`Compose stack "${projectName}" already running on port ${port}`)
					return true
				}

				logger.info(`Compose stack not running on port ${port}, starting...`)
				try {
					await this.startComposeServer(composeFile, projectName, port, dockerConfig.identifier, strategy)
					return true
				} catch (error) {
					logger.error(
						`Failed to start compose stack: ${error instanceof Error ? error.message : 'Unknown error'}`
					)
					return false
				}
			}

			// Single Dockerfile mode
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
	 * Start compose stack in background and wait for the primary port to be ready.
	 */
	private async startComposeServer(
		composeFile: string,
		projectName: string,
		port: number,
		identifier: string,
		strategy: ComposeDevServerStrategy
	): Promise<void> {
		const overrideFile = await strategy.prepareOverrideFile(
			composeFile,
			identifier,
			port,
			await getComposeOverrideDir()
		)

		await strategy.startDetached(composeFile, overrideFile, projectName)

		// Track for cleanup
		this.runningComposeStacks.set(projectName, { port, composeFile, overrideFile })

		// Wait for the primary service port to be ready
		logger.info(`Waiting for compose stack "${projectName}" to start on port ${port}...`)
		const ready = await strategy.waitForReady(
			port,
			this.options.startupTimeout,
			this.options.checkInterval,
			projectName
		)

		if (!ready) {
			// Attempt cleanup on failure
			await strategy.stop(composeFile, overrideFile, projectName).catch(() => undefined)
			this.runningComposeStacks.delete(projectName)
			throw new Error(
				`Compose stack "${projectName}" failed to start within ${this.options.startupTimeout}ms timeout`
			)
		}

		logger.success(`Compose stack "${projectName}" started successfully on port ${port}`)
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
	 * Check if a dev server is running on the specified port.
	 * In docker mode, auto-detects compose vs. single Dockerfile strategy.
	 *
	 * @param port - Port to check
	 * @param dockerConfig - Optional Docker configuration; when provided, checks container/stack status
	 * @param worktreePath - Required when dockerConfig is provided for compose detection
	 * @returns true if server is running, false otherwise
	 */
	async isServerRunning(port: number, dockerConfig?: DockerConfig, worktreePath?: string): Promise<boolean> {
		if (dockerConfig) {
			// Check for compose file if worktreePath is provided
			const composeFile = worktreePath ? await findComposeFile(worktreePath) : null

			if (composeFile) {
				const projectName = ComposeDevServerStrategy.buildProjectName(dockerConfig.identifier)
				const strategy = this.createComposeStrategy()
				return strategy.isStackRunning(projectName)
			}

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
	 * In docker mode, auto-detects compose files to choose the right strategy.
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
		dockerConfig?: DockerConfig
	): Promise<{ pid?: number }> {
		// Docker mode: auto-detect compose vs. single Dockerfile
		if (dockerConfig) {
			const composeFile = await findComposeFile(worktreePath)

			if (composeFile) {
				// Compose foreground mode
				logger.debug(`Starting compose stack in foreground on port ${port}`)
				const projectName = ComposeDevServerStrategy.buildProjectName(dockerConfig.identifier)
				const strategy = this.createComposeStrategy()

				const overrideFile = await strategy.prepareOverrideFile(
					composeFile,
					dockerConfig.identifier,
					port,
					await getComposeOverrideDir()
				)

				if (onProcessStarted) {
					onProcessStarted(undefined)
				}

				this.runningComposeStacks.set(projectName, { port, composeFile, overrideFile })
				try {
					await strategy.startForeground(composeFile, overrideFile, projectName, {
						redirectToStderr,
						envOverrides,
					})
				} finally {
					this.runningComposeStacks.delete(projectName)
				}

				return {}
			}

			// Single Dockerfile foreground mode
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
					{ redirectToStderr, envOverrides }
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
		})
	}

	/**
	 * Clean up all running server processes, Docker containers, and compose stacks.
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

		// Clean up compose stacks
		for (const [projectName, { port, composeFile, overrideFile }] of this.runningComposeStacks.entries()) {
			try {
				logger.debug(`Cleaning up compose stack "${projectName}" on port ${port}`)
				const strategy = this.createComposeStrategy()
				await strategy.stop(composeFile, overrideFile, projectName)
			} catch (error) {
				logger.warn(
					`Failed to stop compose stack "${projectName}" on port ${port}: ${error instanceof Error ? error.message : 'Unknown error'}`
				)
			}
			// Clean up the generated override file regardless of whether stop succeeded
			await fs.unlink(overrideFile).catch(() => undefined)
		}
		this.runningComposeStacks.clear()
	}
}
