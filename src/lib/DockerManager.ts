import { execa } from 'execa'
import { readFile } from 'fs/promises'
import { logger } from '../utils/logger.js'

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
 * Maximum length for Docker container names.
 * Docker allows up to 63 characters for container names.
 */
const MAX_CONTAINER_NAME_LENGTH = 63

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
		try {
			const result = await execa('docker', ['info'], { reject: false })
			return result.exitCode === 0
		} catch {
			return false
		}
	}

	/**
	 * Assert that Docker is available, throwing a clear error if not.
	 * Call this early in any workflow that requires Docker.
	 */
	static async assertAvailable(): Promise<void> {
		const available = await DockerManager.isAvailable()
		if (!available) {
			throw new Error(
				'Docker is not available. Please ensure Docker is installed and the Docker daemon is running.\n' +
					'Install Docker: https://docs.docker.com/get-docker/'
			)
		}
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
	 * Returns the first exposed port number, or null if none found.
	 *
	 * Handles formats like:
	 * - EXPOSE 4200
	 * - EXPOSE 4200/tcp
	 * - EXPOSE 8080/udp
	 *
	 * @param dockerfilePath - Absolute path to the Dockerfile
	 * @returns First exposed port number, or null if no EXPOSE directive found
	 */
	static async parseExposeFromDockerfile(
		dockerfilePath: string
	): Promise<number | null> {
		try {
			const content = await readFile(dockerfilePath, 'utf-8')
			const match = /^EXPOSE\s+(\d+)/m.exec(content)

			if (match?.[1]) {
				const port = parseInt(match[1], 10)
				if (!isNaN(port) && port >= 1 && port <= 65535) {
					return port
				}
			}

			return null
		} catch {
			return null
		}
	}

	/**
	 * Sanitize a string for use as a Docker container name.
	 *
	 * Docker container names must match: [a-zA-Z0-9][a-zA-Z0-9_.-]
	 * - Replace slashes, spaces, and other invalid characters with hyphens
	 * - Ensure the name starts with an alphanumeric character
	 * - Truncate to a maximum of 63 characters
	 *
	 * @param name - Raw name to sanitize
	 * @returns Sanitized container name
	 */
	static sanitizeContainerName(name: string): string {
		// Replace any character that isn't alphanumeric, underscore, dot, or hyphen with a hyphen
		let sanitized = name.replace(/[^a-zA-Z0-9_.-]/g, '-')

		// Collapse consecutive hyphens into one
		sanitized = sanitized.replace(/-{2,}/g, '-')

		// Remove leading non-alphanumeric characters (Docker requires starting with [a-zA-Z0-9])
		sanitized = sanitized.replace(/^[^a-zA-Z0-9]+/, '')

		// Remove trailing hyphens
		sanitized = sanitized.replace(/-+$/, '')

		// Truncate to max length
		if (sanitized.length > MAX_CONTAINER_NAME_LENGTH) {
			sanitized = sanitized.substring(0, MAX_CONTAINER_NAME_LENGTH)
			// Remove trailing hyphen if truncation created one
			sanitized = sanitized.replace(/-+$/, '')
		}

		// Fallback if everything was stripped
		if (sanitized.length === 0) {
			sanitized = 'iloom-container'
		}

		return sanitized
	}

	/**
	 * Build the standard container name for an iloom dev server.
	 *
	 * @param identifier - Issue number, branch name, or other identifier
	 * @returns Sanitized container name in the format "iloom-dev-{identifier}"
	 */
	static buildContainerName(identifier: string | number): string {
		return DockerManager.sanitizeContainerName(`iloom-dev-${identifier}`)
	}

	/**
	 * Build the standard image name for an iloom dev server.
	 *
	 * @param identifier - Issue number, branch name, or other identifier
	 * @returns Sanitized image name
	 */
	static buildImageName(identifier: string | number): string {
		return DockerManager.sanitizeContainerName(`iloom-dev-${identifier}`)
	}

	/**
	 * Detect exposed ports from a built Docker image using `docker image inspect`.
	 * This is the source of truth for exposed ports as it handles multi-stage builds,
	 * inherited images, and runtime configuration that Dockerfile regex cannot capture.
	 *
	 * @param imageName - Name of the built Docker image to inspect
	 * @returns First exposed port number, or null if none found
	 */
	static async inspectImagePorts(imageName: string): Promise<number | null> {
		try {
			const result = await execa('docker', [
				'image', 'inspect', imageName,
				'--format', '{{json .Config.ExposedPorts}}',
			], { reject: false })

			if (result.exitCode !== 0 || !result.stdout.trim()) {
				return null
			}

			const output = result.stdout.trim()
			// Output format: {"4200/tcp":{},"8080/tcp":{}} or null
			if (output === 'null' || output === '<nil>' || output === '{}') {
				return null
			}

			const parsed: unknown = JSON.parse(output)
			if (typeof parsed !== 'object' || parsed === null) {
				return null
			}

			// Get first key (e.g., "4200/tcp") and extract port number
			const firstKey = Object.keys(parsed)[0]
			if (!firstKey) {
				return null
			}

			const portMatch = /^(\d+)/.exec(firstKey)
			if (portMatch?.[1]) {
				const port = parseInt(portMatch[1], 10)
				if (!isNaN(port) && port >= 1 && port <= 65535) {
					return port
				}
			}

			return null
		} catch {
			return null
		}
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
