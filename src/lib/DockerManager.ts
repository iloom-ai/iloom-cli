import { execa } from 'execa'
import { logger } from '../utils/logger.js'
import { restoreTerminalState } from '../utils/terminal.js'
import {
	isDockerInstalled,
	isDockerRunning,
	assertDockerAvailable,
	parseDockerfileExpose,
	inspectImagePorts,
	sanitizeContainerName,
	buildContainerName,
	buildImageName,
} from '../utils/docker.js'

/**
 * Configuration for Docker-based dev server mode.
 * When provided to DevServerManager methods, the server runs inside a Docker container
 * with port mapping instead of as a local process.
 */
export interface DockerConfig {
	/** Path to Dockerfile (relative to worktree) */
	dockerFile: string
	/** Port inside the container (auto-detected from image inspect or Dockerfile EXPOSE if not set) */
	containerPort?: number | undefined
	/** Build arguments passed as --build-arg to docker build */
	dockerBuildArgs?: Record<string, string> | undefined
	/** Additional docker run flags (e.g., volume mounts) */
	dockerRunArgs?: string[] | undefined
	/** Identifier for container naming (issue number, branch name) */
	identifier: string
}

/**
 * Web settings shape accepted by buildDockerConfigFromSettings.
 * Matches the capabilities.web section of IloomSettings.
 * Uses `| undefined` for optional properties to satisfy exactOptionalPropertyTypes.
 */
interface WebSettings {
	devServer?: 'process' | 'docker' | undefined
	dockerFile?: string | undefined
	containerPort?: number | undefined
	dockerBuildArgs?: Record<string, string> | undefined
	dockerRunArgs?: string[] | undefined
}

/**
 * DockerManager encapsulates all Docker CLI interactions.
 * Used by DevServerManager and ResourceCleanup for Docker-based dev server operations.
 *
 * All methods are static since no instance state is needed -- Docker CLI is stateless.
 */
export class DockerManager {
	/**
	 * Check if Docker CLI is available and daemon is running.
	 * @returns true if Docker is ready, false otherwise
	 */
	static async isAvailable(): Promise<boolean> {
		const installed = await isDockerInstalled()
		if (!installed) return false
		return isDockerRunning()
	}

	/**
	 * Assert that Docker is available, throwing a clear error if not.
	 * Call this early in any workflow that requires Docker.
	 */
	static async assertAvailable(): Promise<void> {
		return assertDockerAvailable()
	}

	/**
	 * Build a Docker image.
	 *
	 * @param cwd - Working directory (worktree path)
	 * @param imageName - Image tag name
	 * @param dockerFile - Path to Dockerfile (relative to cwd)
	 * @param buildArgs - Optional build arguments passed as --build-arg
	 */
	static async buildImage(
		cwd: string,
		imageName: string,
		dockerFile: string,
		buildArgs?: Record<string, string>
	): Promise<void> {
		const args = ['build', '-t', imageName, '-f', dockerFile]

		if (buildArgs) {
			for (const [key, value] of Object.entries(buildArgs)) {
				args.push('--build-arg', `${key}=${value}`)
			}
		}

		// Context directory is always cwd
		args.push('.')

		logger.info(`Building Docker image "${imageName}" from ${dockerFile}...`)

		try {
			await execa('docker', args, {
				cwd,
				stdio: 'inherit',
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			throw new Error(`Docker build failed for image "${imageName}": ${message}`)
		}

		logger.success(`Docker image "${imageName}" built successfully`)
	}

	/**
	 * Run a container in detached mode (background).
	 * If a container with the same name already exists, it is force-removed first.
	 *
	 * @param imageName - Image to run
	 * @param containerName - Container name (must be sanitized)
	 * @param hostPort - Port on the host to map
	 * @param containerPort - Port inside the container
	 * @param additionalArgs - Additional docker run flags (e.g., volume mounts)
	 * @returns Container ID
	 */
	static async runDetached(
		imageName: string,
		containerName: string,
		hostPort: number,
		containerPort: number,
		additionalArgs?: string[]
	): Promise<string> {
		// Force-remove any existing container with same name to avoid name collision
		await DockerManager.forceRemoveContainer(containerName)

		const args = [
			'run', '-d',
			'--name', containerName,
			'-p', `${hostPort}:${containerPort}`,
		]

		if (additionalArgs) {
			args.push(...additionalArgs)
		}

		args.push(imageName)

		logger.info(`Starting Docker container "${containerName}" (${hostPort}:${containerPort})...`)

		try {
			const result = await execa('docker', args)
			const containerId = result.stdout.trim()
			logger.success(`Docker container "${containerName}" started (ID: ${containerId.substring(0, 12)})`)
			return containerId
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error'
			throw new Error(`Failed to start Docker container "${containerName}": ${message}`)
		}
	}

	/**
	 * Run a container in foreground mode (attached, blocking).
	 * The container is automatically removed on exit (--rm flag).
	 * Stdout/stderr are streamed to the terminal.
	 *
	 * Signal forwarding: Captures SIGINT/SIGTERM on the host process and
	 * forwards them to the container via `docker kill --signal` for graceful
	 * shutdown of the framework running inside the container.
	 *
	 * @param imageName - Image to run
	 * @param containerName - Container name (must be sanitized)
	 * @param hostPort - Port on the host to map
	 * @param containerPort - Port inside the container
	 * @param additionalArgs - Additional docker run flags
	 * @param redirectToStderr - If true, redirect stdout/stderr to stderr
	 */
	static async runForeground(
		imageName: string,
		containerName: string,
		hostPort: number,
		containerPort: number,
		additionalArgs?: string[],
		redirectToStderr?: boolean
	): Promise<void> {
		// Force-remove any existing container with same name to avoid name collision
		await DockerManager.forceRemoveContainer(containerName)

		const args = [
			'run',
			'--name', containerName,
			'--rm',
			'-p', `${hostPort}:${containerPort}`,
		]

		if (additionalArgs) {
			args.push(...additionalArgs)
		}

		args.push(imageName)

		logger.info(`Running Docker container "${containerName}" in foreground (${hostPort}:${containerPort})...`)

		const stdio = redirectToStderr
			? [process.stdin, process.stderr, process.stderr] as const
			: 'inherit' as const

		// Set up signal forwarding to gracefully shut down the container
		const forwardSignal = (signal: string): void => {
			logger.debug(`Forwarding ${signal} to container "${containerName}"`)
			void execa('docker', ['kill', `--signal=${signal}`, containerName], { reject: false })
		}

		const onSigint = (): void => forwardSignal('SIGINT')
		const onSigterm = (): void => forwardSignal('SIGTERM')

		process.on('SIGINT', onSigint)
		process.on('SIGTERM', onSigterm)

		try {
			await execa('docker', args, { stdio })
		} finally {
			// Clean up signal handlers to avoid leaks
			process.removeListener('SIGINT', onSigint)
			process.removeListener('SIGTERM', onSigterm)
			restoreTerminalState()
		}
	}

	/**
	 * Stop and remove a container by name using atomic force-remove.
	 * No-op if the container doesn't exist or is already removed.
	 * Uses `docker rm -f` which handles both running and stopped containers
	 * atomically, eliminating race conditions between stop and remove.
	 *
	 * @param containerName - Name of the container to remove
	 * @returns true if a container was removed, false if no container was found
	 */
	static async stopAndRemoveContainer(containerName: string): Promise<boolean> {
		const isRunning = await DockerManager.isContainerRunning(containerName)

		if (!isRunning) {
			logger.debug(`No running container found with name "${containerName}"`)
			// Still try to remove in case container exists but is stopped
			await execa('docker', ['rm', '-f', containerName], { reject: false })
			return false
		}

		logger.info(`Removing Docker container "${containerName}"...`)

		// Atomic force-remove: handles running and stopped containers
		await execa('docker', ['rm', '-f', containerName], { reject: false })

		logger.success(`Docker container "${containerName}" removed`)
		return true
	}

	/**
	 * Check if a named container is currently running.
	 *
	 * @param containerName - Name of the container to check
	 * @returns true if the container is running, false otherwise
	 */
	static async isContainerRunning(containerName: string): Promise<boolean> {
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
	 * Parse the EXPOSE directive from a Dockerfile.
	 * Returns the last exposed port number (handles multi-stage builds correctly),
	 * or null if none found.
	 *
	 * @param dockerfilePath - Absolute path to the Dockerfile
	 * @returns Last exposed port number, or null if no EXPOSE directive found
	 */
	static async parseExposeFromDockerfile(
		dockerfilePath: string
	): Promise<number | null> {
		return parseDockerfileExpose(dockerfilePath)
	}

	/**
	 * Sanitize a string for use as a Docker container name.
	 *
	 * @param name - Raw name to sanitize
	 * @returns Sanitized container name
	 */
	static sanitizeContainerName(name: string): string {
		return sanitizeContainerName(name)
	}

	/**
	 * Build the standard container name for an iloom dev server.
	 *
	 * @param identifier - Issue number, branch name, or other identifier
	 * @returns Sanitized container name in the format "iloom-dev-{identifier}"
	 */
	static buildContainerName(identifier: string | number): string {
		return buildContainerName(identifier)
	}

	/**
	 * Build the standard image name for an iloom dev server.
	 *
	 * @param identifier - Issue number, branch name, or other identifier
	 * @returns Sanitized image name
	 */
	static buildImageName(identifier: string | number): string {
		return buildImageName(identifier)
	}

	/**
	 * Detect exposed ports from a built Docker image using `docker image inspect`.
	 *
	 * @param imageName - Name of the built Docker image to inspect
	 * @returns First exposed port number, or null if none found
	 */
	static async inspectImagePorts(imageName: string): Promise<number | null> {
		return inspectImagePorts(imageName)
	}

	/**
	 * Resolve the container port from config, image inspection, or Dockerfile EXPOSE directive.
	 * Priority: config > docker image inspect > Dockerfile regex
	 * Throws a clear error if no source provides a port.
	 *
	 * @param configPort - Port from settings (containerPort field)
	 * @param dockerfilePath - Absolute path to the Dockerfile
	 * @param imageName - Optional built image name for inspection (preferred over Dockerfile regex)
	 * @returns Resolved container port number
	 */
	static async resolveContainerPort(
		configPort: number | undefined,
		dockerfilePath: string,
		imageName?: string
	): Promise<number> {
		if (configPort !== undefined) {
			return configPort
		}

		// Try image inspection first (most accurate - handles multi-stage builds, inherited images)
		if (imageName) {
			const inspectedPort = await DockerManager.inspectImagePorts(imageName)
			if (inspectedPort !== null) {
				logger.debug(`Auto-detected container port ${inspectedPort} from Docker image inspect`)
				return inspectedPort
			}
		}

		// Fall back to Dockerfile regex
		const exposedPort = await DockerManager.parseExposeFromDockerfile(dockerfilePath)
		if (exposedPort !== null) {
			logger.debug(`Auto-detected container port ${exposedPort} from Dockerfile EXPOSE directive`)
			return exposedPort
		}

		throw new Error(
			`Cannot determine container port. No "containerPort" configured in settings and no EXPOSE directive found in ${dockerfilePath}.\n` +
				'Either add an EXPOSE directive to your Dockerfile or set "containerPort" in capabilities.web settings.'
		)
	}

	/**
	 * Force-remove a container by name (no-op if it doesn't exist).
	 * Used internally before running a new container to avoid name collisions.
	 */
	private static async forceRemoveContainer(containerName: string): Promise<void> {
		await execa('docker', ['rm', '-f', containerName], { reject: false })
	}

	/**
	 * Build a DockerConfig from iloom web settings and an identifier.
	 * Centralizes the Docker config extraction logic used by dev-server, open, and run commands.
	 *
	 * @param webSettings - The capabilities.web section from IloomSettings
	 * @param identifier - Identifier for container naming (issue number, branch name, etc.)
	 * @returns DockerConfig if Docker mode is enabled, undefined otherwise
	 */
	static buildDockerConfigFromSettings(
		webSettings: WebSettings | undefined,
		identifier: string
	): DockerConfig | undefined {
		if (!webSettings || webSettings.devServer !== 'docker') {
			return undefined
		}

		return {
			dockerFile: webSettings.dockerFile ?? './Dockerfile',
			containerPort: webSettings.containerPort,
			dockerBuildArgs: webSettings.dockerBuildArgs,
			dockerRunArgs: webSettings.dockerRunArgs,
			identifier,
		}
	}
}
