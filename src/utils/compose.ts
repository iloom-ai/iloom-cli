import { readFile } from 'fs/promises'
import fs from 'fs-extra'
import path from 'path'
import { parse, stringify } from 'yaml'
import { sanitizeContainerName } from './docker.js'
import { wrapPort } from './port.js'

/**
 * Structured port mapping extracted from a compose file.
 *
 * V1 scope: literal port values only. The following are NOT supported:
 * - Variable interpolation or environment variable substitution
 * - Port ranges (e.g., "8080-8081:8080-8081") — entries with ranges are skipped
 * - Compose profiles, extends, or includes directives
 */
export interface ComposePortMapping {
	service: string
	hostPort: number
	containerPort: number
	protocol?: string
	hostIp?: string
}

/**
 * Parse a docker-compose.yml or compose.yml file and extract port mappings.
 * Handles short syntax ("3000:3000", "3000:3000/tcp", "127.0.0.1:3000:3000") and
 * long-form syntax ({ target, published, protocol, host_ip }).
 * V1: literal values only, no variable interpolation, port ranges are skipped.
 *
 * @param filePath - Absolute path to the compose file
 * @returns Array of port mappings (empty if no ports found)
 * @throws Error if file cannot be read or parsed
 */
export async function parseComposeFile(filePath: string): Promise<ComposePortMapping[]> {
	const content = await readFile(filePath, 'utf-8')
	const doc = parse(content) as Record<string, unknown>

	if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object' || Array.isArray(doc.services)) {
		return []
	}

	const services = doc.services as Record<string, unknown>
	const mappings: ComposePortMapping[] = []

	for (const [serviceName, serviceConfig] of Object.entries(services)) {
		if (!serviceConfig || typeof serviceConfig !== 'object') {
			continue
		}

		const config = serviceConfig as Record<string, unknown>
		if (!config.ports || !Array.isArray(config.ports)) {
			continue
		}

		for (const portEntry of config.ports) {
			if (typeof portEntry === 'string' || typeof portEntry === 'number') {
				// Short syntax: "3000:3000", "3000:3000/tcp", "127.0.0.1:8080:80"
				const portStr = String(portEntry)

				// Split from the right to handle optional IP prefix correctly.
				// Docker allows "host_ip:host_port:container_port" format.
				const parts = portStr.split(':')

				// Skip container-only entries (no host port mapping)
				if (parts.length < 2) {
					continue
				}

				// The container part is always the last segment (may include protocol: "80/tcp")
				const rawContainerPart = parts[parts.length - 1]
				const rawHostPart = parts[parts.length - 2]
				// Guard for TypeScript strict mode (length >= 2 guarantees both exist)
				if (rawContainerPart === undefined || rawHostPart === undefined) {
					continue
				}
				const hostIp = parts.length >= 3 ? parts.slice(0, parts.length - 2).join(':') : undefined

				// Detect and skip port ranges (e.g., "8080-8081")
				const containerBase = rawContainerPart.split('/')[0] ?? ''
				if (rawHostPart.includes('-') || containerBase.includes('-')) {
					continue
				}

				// Parse optional protocol from container port
				let containerPart = rawContainerPart
				let protocol: string | undefined

				const slashIndex = rawContainerPart.indexOf('/')
				if (slashIndex !== -1) {
					containerPart = rawContainerPart.substring(0, slashIndex)
					protocol = rawContainerPart.substring(slashIndex + 1)
				}

				const hostPort = parseInt(rawHostPart, 10)
				const containerPort = parseInt(containerPart, 10)

				if (isNaN(hostPort) || isNaN(containerPort)) {
					continue
				}

				const mapping: ComposePortMapping = {
					service: serviceName,
					hostPort,
					containerPort,
				}
				if (protocol !== undefined) {
					mapping.protocol = protocol
				}
				if (hostIp !== undefined && hostIp !== '') {
					mapping.hostIp = hostIp
				}

				mappings.push(mapping)
			} else if (portEntry && typeof portEntry === 'object') {
				// Long-form syntax: { target: 80, published: 8080, protocol: 'tcp', host_ip: '127.0.0.1' }
				const longForm = portEntry as Record<string, unknown>

				// Skip if no published (host) port
				if (longForm.published === undefined || longForm.published === null) {
					continue
				}

				const hostPort = typeof longForm.published === 'number'
					? longForm.published
					: parseInt(String(longForm.published), 10)
				const containerPort = typeof longForm.target === 'number'
					? longForm.target
					: parseInt(String(longForm.target), 10)

				if (isNaN(hostPort) || isNaN(containerPort)) {
					continue
				}

				const mapping: ComposePortMapping = {
					service: serviceName,
					hostPort,
					containerPort,
				}

				if (longForm.protocol !== undefined && typeof longForm.protocol === 'string') {
					mapping.protocol = longForm.protocol
				}

				if (longForm.host_ip !== undefined && typeof longForm.host_ip === 'string' && longForm.host_ip !== '') {
					mapping.hostIp = longForm.host_ip
				}

				mappings.push(mapping)
			}
		}
	}

	return mappings
}

/**
 * Generate a docker-compose.override.yml with host ports offset by identifier.
 * Writes the file to dataDir (outside the worktree, not in git).
 *
 * Port offset: newHostPort = wrapPort(hostPort + numericIdentifier, hostPort)
 * The identifier must be a numeric value or a string that parses to a number.
 *
 * If a mapping includes a hostIp, the override preserves it to avoid
 * unintentionally exposing the port on all interfaces.
 *
 * @param mappings - Port mappings from parseComposeFile()
 * @param identifier - Numeric identifier (issue number) for port offset
 * @param dataDir - Directory to write the override file
 * @returns Absolute path to the generated override file
 * @throws Error if identifier is not a valid number
 */
export async function generateOverrideFile(
	mappings: ComposePortMapping[],
	identifier: string | number,
	dataDir: string
): Promise<string> {
	const numId = typeof identifier === 'number' ? identifier : parseInt(identifier, 10)

	if (isNaN(numId)) {
		throw new Error(`Invalid identifier: "${identifier}". Expected a numeric value or numeric string.`)
	}

	// Build override structure grouped by service
	const servicesOverride: Record<string, { ports: string[] }> = {}

	for (const mapping of mappings) {
		const offsetPort = wrapPort(mapping.hostPort + numId, mapping.hostPort)

		// Preserve host IP binding to avoid exposing internal services on 0.0.0.0
		let portStr: string
		const hostPrefix = mapping.hostIp !== undefined ? `${mapping.hostIp}:` : ''
		if (mapping.protocol !== undefined) {
			portStr = `${hostPrefix}${offsetPort}:${mapping.containerPort}/${mapping.protocol}`
		} else {
			portStr = `${hostPrefix}${offsetPort}:${mapping.containerPort}`
		}

		const existing = servicesOverride[mapping.service]
		if (!existing) {
			servicesOverride[mapping.service] = { ports: [portStr] }
		} else {
			existing.ports.push(portStr)
		}
	}

	const overrideDoc = {
		services: servicesOverride,
	}

	const yamlContent = stringify(overrideDoc)

	await fs.ensureDir(dataDir)

	const projectName = `iloom-${sanitizeContainerName(String(identifier))}`
	const filePath = path.join(dataDir, `${projectName}.yml`)
	await fs.writeFile(filePath, yamlContent, 'utf-8')

	return filePath
}
