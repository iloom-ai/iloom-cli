import { execa, type ExecaError } from 'execa'
import net from 'net'
import { logger } from '../utils/logger.js'
import { restoreTerminalState } from '../utils/terminal.js'
import { expandAndValidateSecretPaths } from '../utils/docker.js'

/**
 * Docker configuration shape consumed by DockerDevServerStrategy.
 * Matches the DevServerSettings['docker'] shape from the settings schema.
 */
export interface DockerConfig {
	/** Path to Dockerfile (relative to worktree) */
	dockerFile?: string | undefined
	/** Port inside the container (auto-detected from image inspect or Dockerfile EXPOSE if not set) */
	containerPort?: number | undefined
	/** Build arguments passed as --build-arg to docker build */
	buildArgs?: Record<string, string> | undefined
	/** Secret files to mount during docker build via BuildKit --secret flag */
	buildSecrets?: Record<string, string> | undefined
	/** Additional docker run flags */
	runArgs?: string[] | undefined
	/** Identifier for naming containers/images (issue number, branch name). Falls back to worktreePath if not set. */
	identifier?: string | undefined
	/** Protocol for displayed URLs (http or https, default http) */
	protocol?: 'http' | 'https' | undefined
}

/**
 * Options for runContainerForeground.
 */
export interface RunForegroundOptions {
	/** If true, redirect stdout/stderr to process.stderr */
	redirectToStderr?: boolean | undefined
	/** Called immediately after the container starts */
	onProcessStarted?: ((pid?: number) => void) | undefined
	/** Additional environment variables to forward into the container */
	envOverrides?: Record<string, string> | undefined
}

/**
 * Utility function contracts from the docker-utils sibling issue.
 * Coded against these shapes so this class compiles without waiting for the sibling merge.
 */
type ParseDockerfileExposeFn = (path: string) => Promise<number | null>
type InspectImagePortsFn = (name: string) => Promise<number | null>
type BuildContainerNameFn = (id: string | number) => string
type BuildImageNameFn = (id: string | number) => string
type AssertDockerAvailableFn = () => Promise<void>

/**
 * Injected docker utility functions.
 * Default implementations are imported from DockerManager for backward compatibility
 * until the dedicated docker-utils module is merged.
 */
export interface DockerUtils {
	parseDockerfileExpose: ParseDockerfileExposeFn
	inspectImagePorts: InspectImagePortsFn
	buildContainerName: BuildContainerNameFn
	buildImageName: BuildImageNameFn
	assertDockerAvailable: AssertDockerAvailableFn
}

/**
 * Attempt a single TCP connection to localhost:port.
 * Resolves true if the connection succeeds, false otherwise.
 */
function tcpProbe(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: '127.0.0.1' })
		socket.once('connect', () => {
			socket.destroy()
			resolve(true)
		})
		socket.once('error', () => {
			socket.destroy()
			resolve(false)
		})
	})
}

/**
 * DockerDevServerStrategy handles the full Docker container lifecycle for a dev server:
 * - Image building
 * - Container running (detached and foreground)
 * - Container stopping
 * - Readiness detection via TCP probe
 * - Port resolution (3-tier: config > image inspect > Dockerfile EXPOSE)
 *
 * This class is the core Docker logic delegated to by DevServerManager.
 * It does NOT modify DevServerManager, ResourceCleanup, or CLI commands.
 */
export class DockerDevServerStrategy {
	private readonly utils: DockerUtils

	constructor(_config: DockerConfig, utils: DockerUtils) {
		this.utils = utils
	}

	/**
	 * Resolve the container port using 3-tier fallback:
	 *   1. config.containerPort (explicit)
	 *   2. inspectImagePorts(imageName) (from built image)
	 *   3. parseDockerfileExpose(dockerfilePath) (from Dockerfile)
	 *
	 * Throws a clear error if all three return null.
	 *
	 * @param config - Docker config (may override the constructor config)
	 * @param imageName - Name of the built Docker image
	 * @param dockerfilePath - Absolute path to the Dockerfile
	 */
	async resolveContainerPort(
		config: DockerConfig,
		imageName: string,
		dockerfilePath: string
	): Promise<number> {
		if (config.containerPort !== undefined) {
			return config.containerPort
		}

		const inspectedPort = await this.utils.inspectImagePorts(imageName)
		if (inspectedPort !== null) {
			logger.debug(`Auto-detected container port ${inspectedPort} from Docker image inspect`)
			return inspectedPort
		}

		const exposedPort = await this.utils.parseDockerfileExpose(dockerfilePath)
		if (exposedPort !== null) {
			logger.debug(`Auto-detected container port ${exposedPort} from Dockerfile EXPOSE directive`)
			return exposedPort
		}

		throw new Error(
			'Cannot determine container port. Set `devServer.docker.containerPort` in settings or add an `EXPOSE` directive to your Dockerfile.'
		)
	}

	/**
	 * Build a Docker image for the worktree.
	 * Build context is always the worktree root directory.
	 *
	 * @param worktreePath - Absolute path to the worktree (build context)
	 * @param config - Docker config with Dockerfile path and build args
	 */
	async buildImage(worktreePath: string, config: DockerConfig): Promise<void> {
		const imageName = this.utils.buildImageName(config.identifier ?? worktreePath)
		const dockerfilePath = config.dockerFile ?? './Dockerfile'

		const args = ['build', '-t', imageName, '-f', dockerfilePath]

		if (config.buildArgs) {
			for (const [key, value] of Object.entries(config.buildArgs)) {
				args.push('--build-arg', `${key}=${value}`)
			}
		}

		// Mount secret files via BuildKit --secret flags
		const expandedSecrets = expandAndValidateSecretPaths(config.buildSecrets, worktreePath)
		for (const [id, srcPath] of Object.entries(expandedSecrets)) {
			args.push('--secret', `id=${id},src=${srcPath}`)
		}

		// Context is always the worktree root
		args.push('.')

		logger.info(`Building Docker image "${imageName}" from ${dockerfilePath}...`)

		const execaOptions: { cwd: string; stdio: 'inherit'; env?: Record<string, string> } = {
			cwd: worktreePath,
			stdio: 'inherit',
		}

		// Enable BuildKit when secrets are being used (required for --secret flag on older Docker versions)
		if (Object.keys(expandedSecrets).length > 0) {
			execaOptions.env = { ...process.env, DOCKER_BUILDKIT: '1' }
		}

		try {
			await execa('docker', args, execaOptions)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			throw new Error(`Docker build failed for image "${imageName}": ${message}`)
		}

		logger.success(`Docker image "${imageName}" built successfully`)
	}

	/**
	 * Run a container in detached (background) mode.
	 * Force-removes any existing container with the same name first.
	 * Mounts the worktree at /app and adds an anonymous volume for node_modules.
	 * Forwards PORT and any envOverrides into the container.
	 *
	 * @param worktreePath - Absolute path to the worktree (mounted at /app)
	 * @param hostPort - Port on the host to map
	 * @param containerPort - Port inside the container
	 * @param config - Docker config with run args
	 * @param envOverrides - Additional environment variables to set in the container
	 * @returns The container name
	 */
	async runContainerDetached(
		worktreePath: string,
		hostPort: number,
		containerPort: number,
		config: DockerConfig,
		envOverrides?: Record<string, string>
	): Promise<string> {
		const nameId = config.identifier ?? worktreePath
		const imageName = this.utils.buildImageName(nameId)
		const containerName = this.utils.buildContainerName(nameId)

		// Force-remove any existing container with same name
		await execa('docker', ['rm', '-f', containerName], { reject: false })

		const args = [
			'run', '-d',
			'--name', containerName,
			'-p', `${hostPort}:${containerPort}`,
			// Mount worktree at /app
			'-v', `${worktreePath}:/app`,
			// Anonymous volume for node_modules to prevent host/container conflicts
			'-v', '/app/node_modules',
			// Forward PORT as the container port so the app listens where Docker expects.
			// The -p mapping handles host-to-container translation.
			'-e', `PORT=${containerPort}`,
		]

		// Forward additional environment variables
		if (envOverrides) {
			for (const [key, value] of Object.entries(envOverrides)) {
				args.push('-e', `${key}=${value}`)
			}
		}

		// Additional run flags from config
		if (config.runArgs) {
			args.push(...config.runArgs)
		}

		args.push(imageName)

		const displayProtocol = config.protocol ?? 'http'
		logger.info(`Starting Docker container "${containerName}" in background (${displayProtocol}://localhost:${hostPort} → container:${containerPort})...`)

		try {
			await execa('docker', args)
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			throw new Error(`Failed to start Docker container "${containerName}": ${message}`)
		}

		logger.success(`Docker container "${containerName}" started on port ${hostPort}`)
		return containerName
	}

	/**
	 * Run a container in foreground (blocking) mode.
	 * The container is automatically removed on exit (--rm flag).
	 * Traps SIGINT and SIGTERM and forwards them to the container via docker stop.
	 *
	 * @param worktreePath - Absolute path to the worktree (mounted at /app)
	 * @param hostPort - Port on the host to map
	 * @param containerPort - Port inside the container
	 * @param config - Docker config with run args
	 * @param opts - Additional options (redirectToStderr, onProcessStarted, envOverrides)
	 * @returns Object with optional pid (Docker containers don't expose host PID)
	 */
	async runContainerForeground(
		worktreePath: string,
		hostPort: number,
		containerPort: number,
		config: DockerConfig,
		opts: RunForegroundOptions = {}
	): Promise<{ pid?: number }> {
		const nameId = config.identifier ?? worktreePath
		const imageName = this.utils.buildImageName(nameId)
		const containerName = this.utils.buildContainerName(nameId)
		const { redirectToStderr, onProcessStarted, envOverrides } = opts

		// Force-remove any existing container with same name (stale from previous ungraceful exit)
		await execa('docker', ['rm', '-f', containerName], { reject: false })

		const args = [
			'run', '--rm',
			'--name', containerName,
			'-p', `${hostPort}:${containerPort}`,
			// Mount worktree at /app
			'-v', `${worktreePath}:/app`,
			// Anonymous volume for node_modules to prevent host/container conflicts
			'-v', '/app/node_modules',
			// Forward PORT as the container port so the app listens where Docker expects.
			// The -p mapping handles host-to-container translation.
			'-e', `PORT=${containerPort}`,
		]

		// Forward additional environment variables
		if (envOverrides) {
			for (const [key, value] of Object.entries(envOverrides)) {
				args.push('-e', `${key}=${value}`)
			}
		}

		// Additional run flags from config
		if (config.runArgs) {
			args.push(...config.runArgs)
		}

		args.push(imageName)

		const displayProtocol = config.protocol ?? 'http'
		logger.info(`Running Docker container "${containerName}" in foreground (${displayProtocol}://localhost:${hostPort} → container:${containerPort})...`)

		const stdio = redirectToStderr
			? [process.stdin, process.stderr, process.stderr] as const
			: 'inherit' as const

		// Signal forwarding: trap SIGINT/SIGTERM and forward to container
		const forwardSignal = (): void => {
			logger.debug(`Stopping container "${containerName}"`)
			void execa('docker', ['stop', containerName], { reject: false })
		}

		const onSigint = (): void => forwardSignal()
		const onSigterm = (): void => forwardSignal()

		process.on('SIGINT', onSigint)
		process.on('SIGTERM', onSigterm)

		if (onProcessStarted) {
			onProcessStarted(undefined)
		}

		try {
			await execa('docker', args, { stdio })
		} catch (error) {
			const execaError = error as ExecaError
			// When the user presses Ctrl+C, the signal handler calls `docker stop`,
			// which causes `docker run` to exit with code 143 (128+SIGTERM) or 130
			// (128+SIGINT). Execa may also report the signal name directly. These
			// are all expected shutdown paths and should not surface as errors.
			const isExpectedShutdown =
				execaError.exitCode === 143 ||
				execaError.exitCode === 130 ||
				execaError.signal === 'SIGTERM' ||
				execaError.signal === 'SIGINT'
			if (!isExpectedShutdown) {
				throw error
			}
		} finally {
			// Clean up signal handlers to avoid leaks
			process.removeListener('SIGINT', onSigint)
			process.removeListener('SIGTERM', onSigterm)
			restoreTerminalState()
		}

		return {}
	}

	/**
	 * Stop and remove a container by name.
	 * Uses docker rm -f which handles both running and stopped containers atomically.
	 * Handles already-stopped containers gracefully (no error thrown).
	 *
	 * @param containerName - Name of the container to stop and remove
	 */
	async stopContainer(containerName: string): Promise<void> {
		logger.debug(`Stopping and removing container "${containerName}"...`)
		await execa('docker', ['rm', '-f', containerName], { reject: false })
		logger.debug(`Container "${containerName}" stopped and removed`)
	}

	/**
	 * Check if a named container is currently running.
	 * Uses exact name matching with anchored regex to avoid partial name matches.
	 *
	 * @param containerName - Name of the container to check
	 * @returns true if the container is running, false otherwise
	 */
	async isContainerRunning(containerName: string): Promise<boolean> {
		try {
			const result = await execa('docker', [
				'ps',
				'--filter', `name=^${containerName}$`,
				'--format', '{{.Names}}',
			], { reject: false })

			return result.exitCode === 0 && result.stdout.trim() === containerName
		} catch {
			return false
		}
	}

	/**
	 * Wait for the dev server to be ready by probing the TCP port.
	 * Uses net.createConnection instead of lsof-based detection since Docker port
	 * forwarding shows com.docker.backend as the listening process (not the dev server).
	 * Exits early if the container has stopped (crash detection).
	 *
	 * @param port - Host port to probe
	 * @param timeout - Maximum time to wait in milliseconds
	 * @param interval - Interval between probes in milliseconds
	 * @param containerName - Optional container name to monitor for early exit
	 * @returns true if the port accepts connections within the timeout, false otherwise
	 */
	async waitForReady(port: number, timeout: number, interval: number, containerName?: string): Promise<boolean> {
		const startTime = Date.now()
		let attempts = 0

		while (Date.now() - startTime < timeout) {
			attempts++

			// Early exit: if the container has stopped, stop polling
			if (containerName && attempts % 3 === 0) {
				const stillRunning = await this.isContainerRunning(containerName)
				if (!stillRunning) {
					logger.warn(
						`Docker container "${containerName}" exited before becoming ready (after ${attempts} attempts, ${Date.now() - startTime}ms)`
					)
					return false
				}
			}

			const isReady = await tcpProbe(port)
			if (isReady) {
				return true
			}

			await new Promise<void>((resolve) => globalThis.setTimeout(resolve, interval))
		}

		return false
	}
}
