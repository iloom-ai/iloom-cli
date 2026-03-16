import { detectPackageManager } from './package-manager.js'
import { getPackageScripts } from './package-json.js'
import { logger } from './logger.js'
import type { Capability } from '../types/loom.js'

/**
 * Build the dev server URL from port and protocol
 */
export function buildDevServerUrl(port: number, protocol: 'http' | 'https' = 'http'): string {
	return `${protocol}://localhost:${port}`
}

/**
 * Build dev server command for workspace
 * Detects package manager and constructs appropriate command
 */
export async function buildDevServerCommand(
	workspacePath: string
): Promise<string> {
	// Check for iloom config dev script first (package.iloom.json / package.iloom.local.json)
	const scripts = await getPackageScripts(workspacePath)
	const devScript = scripts['dev']

	if (devScript?.source === 'iloom-config') {
		logger.debug(`Dev server command (from iloom config): ${devScript.command}`)
		return devScript.command
	}

	const packageManager = await detectPackageManager(workspacePath)

	let devCommand: string

	switch (packageManager) {
		case 'pnpm':
			devCommand = 'pnpm dev'
			break
		case 'npm':
			devCommand = 'npm run dev'
			break
		case 'yarn':
			devCommand = 'yarn dev'
			break
		default:
			// Fallback to npm (handles bun and other package managers)
			logger.warn(`Unknown or unsupported package manager: ${packageManager}, defaulting to npm`)
			devCommand = 'npm run dev'
	}

	logger.debug(`Dev server command: ${devCommand}`)
	return devCommand
}

/**
 * Build complete dev server launch command for terminal
 * Includes VSCode launch, echo message (only for web projects), and dev server start
 */
export async function getDevServerLaunchCommand(
	workspacePath: string,
	port?: number,
	capabilities: Capability[] = []
): Promise<string> {
	const devCommand = await buildDevServerCommand(workspacePath)

	const commands: string[] = []

	// // Open VSCode
	// commands.push('code .')

	// Echo message (only for web projects)
	if (capabilities.includes('web')) {
		if (port !== undefined) {
			commands.push(`echo 'Starting dev server on PORT=${port}...'`)
		} else {
			commands.push(`echo 'Starting dev server...'`)
		}
	}

	// Start dev server
	commands.push(devCommand)

	return commands.join(' && ')
}
