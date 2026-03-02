import { execa } from 'execa'
import { readFile } from 'fs/promises'

/**
 * Maximum length for Docker container names.
 * Docker allows up to 63 characters for container names.
 */
const MAX_CONTAINER_NAME_LENGTH = 63

/**
 * Check if Docker CLI is installed.
 * Runs `docker --version` — only checks CLI presence, not daemon status.
 * @returns true if Docker CLI is installed, false otherwise
 */
export async function isDockerInstalled(): Promise<boolean> {
	try {
		const result = await execa('docker', ['--version'], { reject: false })
		return result.exitCode === 0
	} catch {
		return false
	}
}

/**
 * Check if the Docker daemon is running.
 * Runs `docker info` — requires the daemon to be running.
 * @returns true if Docker daemon is running, false otherwise
 */
export async function isDockerRunning(): Promise<boolean> {
	try {
		const result = await execa('docker', ['info'], { reject: false })
		return result.exitCode === 0
	} catch {
		return false
	}
}

/**
 * Assert that Docker is installed and the daemon is running.
 * Throws a clear, actionable error if either check fails.
 */
export async function assertDockerAvailable(): Promise<void> {
	const installed = await isDockerInstalled()
	if (!installed) {
		throw new Error(
			'Docker is not installed. Please install Docker to use this feature.\n' +
				'Install Docker: https://docs.docker.com/get-docker/'
		)
	}

	const running = await isDockerRunning()
	if (!running) {
		throw new Error(
			'Docker daemon is not running. Please start Docker and try again.\n' +
				'On macOS/Windows: Open the Docker Desktop application.\n' +
				'On Linux: Run `sudo systemctl start docker`'
		)
	}
}

/**
 * Parse the EXPOSE directive from a Dockerfile.
 * Returns the LAST exposed port number (handles multi-stage builds correctly),
 * or null if none found.
 *
 * Handles formats like:
 * - EXPOSE 4200
 * - EXPOSE 4200/tcp
 * - EXPOSE 8080/udp
 * - Ignores comment lines (# EXPOSE ...)
 *
 * @param dockerfilePath - Absolute path to the Dockerfile
 * @returns Last exposed port number, or null if no valid EXPOSE directive found
 */
export async function parseDockerfileExpose(
	dockerfilePath: string
): Promise<number | null> {
	try {
		const content = await readFile(dockerfilePath, 'utf-8')
		const lines = content.split('\n')
		let lastPort: number | null = null

		for (const line of lines) {
			const trimmed = line.trim()
			// Skip comment lines
			if (trimmed.startsWith('#')) {
				continue
			}

			const match = /^EXPOSE\s+(\d+)/i.exec(trimmed)
			if (match?.[1]) {
				const port = parseInt(match[1], 10)
				if (!isNaN(port) && port >= 1 && port <= 65535) {
					lastPort = port
				}
			}
		}

		return lastPort
	} catch {
		return null
	}
}

/**
 * Detect exposed ports from a built Docker image using `docker image inspect`.
 * Returns the first exposed port number, or null if none found.
 *
 * @param imageName - Name of the built Docker image to inspect
 * @returns First exposed port number, or null if none found
 */
export async function inspectImagePorts(imageName: string): Promise<number | null> {
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
export function sanitizeContainerName(name: string | number): string {
	let sanitized = String(name)

	// Replace any character that isn't alphanumeric, underscore, dot, or hyphen with a hyphen
	sanitized = sanitized.replace(/[^a-zA-Z0-9_.-]/g, '-')

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
export function buildContainerName(identifier: string | number): string {
	return sanitizeContainerName(`iloom-dev-${identifier}`)
}

/**
 * Build the standard image name for an iloom dev server.
 *
 * @param identifier - Issue number, branch name, or other identifier
 * @returns Sanitized image name in the format "iloom-dev-{identifier}"
 */
export function buildImageName(identifier: string | number): string {
	// Docker image tags must be lowercase
	return sanitizeContainerName(`iloom-dev-${identifier}`).toLowerCase()
}
