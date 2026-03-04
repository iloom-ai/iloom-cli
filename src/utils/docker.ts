import { execa } from 'execa'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { parse as yamlParse, YAMLParseError } from 'yaml'

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

/**
 * Information about a single service in a compose file.
 */
export interface ComposeServiceInfo {
	name: string
	ports: Array<{ host?: number; container: number }>
	image?: string
}

/**
 * Result of detecting a compose file in a project directory.
 */
export interface ComposeDetectionResult {
	filePath: string
	fileName: string
	services: ComposeServiceInfo[]
}

/**
 * Parse port mappings from a compose service's ports array.
 * Handles both short syntax ("8080:80", "80") and long syntax ({ target, published }).
 */
function parseComposePorts(
	ports: unknown
): Array<{ host?: number; container: number }> {
	if (!Array.isArray(ports)) {
		return []
	}

	const result: Array<{ host?: number; container: number }> = []

	for (const port of ports) {
		if (typeof port === 'string' || typeof port === 'number') {
			// Short syntax: "host:container", "ip:host:container", or "container"
			const portStr = String(port)
			const parts = portStr.split(':')
			if (parts.length >= 2) {
				// Take last part as container, second-to-last as host (handles IP:HOST:CONTAINER)
				const rawContainer = parts[parts.length - 1]
				const rawHost = parts[parts.length - 2]
				// Guard for TypeScript strict mode (length >= 2 guarantees both exist)
				if (rawContainer === undefined || rawHost === undefined) {
					continue
				}
				const containerPart = parseInt(rawContainer, 10)
				const hostPart = parseInt(rawHost, 10)
				if (!isNaN(containerPart) && containerPart >= 1 && containerPart <= 65535) {
					const validHost = !isNaN(hostPart) && hostPart >= 1 && hostPart <= 65535
					if (validHost) {
						result.push({ host: hostPart, container: containerPart })
					} else {
						result.push({ container: containerPart })
					}
				}
			} else {
				const containerPort = parseInt(portStr, 10)
				if (!isNaN(containerPort) && containerPort >= 1 && containerPort <= 65535) {
					result.push({ container: containerPort })
				}
			}
		} else if (typeof port === 'object' && port !== null) {
			// Long syntax: { target: number, published?: number }
			const longPort = port as Record<string, unknown>
			const target = typeof longPort['target'] === 'number' ? longPort['target'] : undefined
			const published =
				typeof longPort['published'] === 'number'
					? longPort['published']
					: typeof longPort['published'] === 'string'
						? parseInt(longPort['published'] as string, 10)
						: undefined
			if (target !== undefined && target >= 1 && target <= 65535) {
				const validPublished = published !== undefined && published >= 1 && published <= 65535
				if (validPublished) {
					result.push({ host: published, container: target })
				} else {
					result.push({ container: target })
				}
			}
		}
	}

	return result
}

/**
 * Detect and parse a Docker Compose file in the given project directory.
 * Checks for compose.yml first, then docker-compose.yml (compose.yml takes priority per Docker docs).
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Parsed compose detection result, or null if no compose file found
 */
export async function detectComposeFile(
	projectRoot: string
): Promise<ComposeDetectionResult | null> {
	const candidates = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml']

	for (const fileName of candidates) {
		const filePath = path.join(projectRoot, fileName)
		if (!existsSync(filePath)) {
			continue
		}

		try {
			const content = await readFile(filePath, 'utf-8')
			const parsed = yamlParse(content)

			if (typeof parsed !== 'object' || parsed === null) {
				return { filePath, fileName, services: [] }
			}

			const doc = parsed as Record<string, unknown>
			const servicesRaw = doc['services']

			if (typeof servicesRaw !== 'object' || servicesRaw === null) {
				return { filePath, fileName, services: [] }
			}

			const servicesMap = servicesRaw as Record<string, unknown>
			const services: ComposeServiceInfo[] = []

			for (const [name, serviceRaw] of Object.entries(servicesMap)) {
				if (typeof serviceRaw !== 'object' || serviceRaw === null) {
					services.push({ name, ports: [] })
					continue
				}

				const service = serviceRaw as Record<string, unknown>
				const ports = parseComposePorts(service['ports'])

				if (typeof service['image'] === 'string') {
					services.push({ name, ports, image: service['image'] })
				} else {
					services.push({ name, ports })
				}
			}

			return { filePath, fileName, services }
		} catch (error) {
			if (error instanceof YAMLParseError) {
				// Expected: malformed YAML — detection is non-fatal
				return null
			}
			// Unexpected error (e.g., permissions issue) — rethrow so it is not silently swallowed
			throw error
		}
	}

	return null
}
