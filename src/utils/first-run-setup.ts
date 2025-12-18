import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { logger } from './logger.js'
import { FirstRunManager } from './FirstRunManager.js'
import { getRepoRoot } from './git.js'
import { InitCommand } from '../commands/init.js'

/**
 * Get the project root path for first-run tracking
 * Uses git repo root if available, otherwise falls back to cwd
 * This ensures consistent path resolution regardless of where the CLI is run from
 */
async function getProjectRoot(): Promise<string> {
	const repoRoot = await getRepoRoot()
	if (repoRoot) {
		logger.debug(`getProjectRoot: Using git repo root: ${repoRoot}`)
		return repoRoot
	}
	const cwd = process.cwd()
	logger.debug(`getProjectRoot: Not in git repo, using cwd: ${cwd}`)
	return cwd
}

/**
 * Check if project needs first-run setup
 * Returns true if:
 * 1. Project is not tracked as configured globally AND
 * 2. .iloom directory is missing or settings files are empty
 *
 * Also performs fixup for legacy projects that have local config but lack
 * the global marker file (configured before global tracking was implemented)
 *
 * Uses git repo root for path resolution to ensure consistent behavior
 * regardless of whether the CLI is run from a subdirectory or worktree
 */
export async function needsFirstRunSetup(): Promise<boolean> {
	const projectRoot = await getProjectRoot()
	const firstRunManager = new FirstRunManager()

	// Fixup legacy projects that have local config but no global marker
	// This also returns whether the project is configured, avoiding duplicate isProjectConfigured() call
	const { isConfigured } = await firstRunManager.fixupLegacyProject(projectRoot)

	// Check if project is tracked as configured globally
	if (isConfigured) {
		logger.debug('needsFirstRunSetup: Project is tracked as configured globally')
		return false
	}

	const iloomDir = path.join(projectRoot, '.iloom')

	// Check if .iloom directory exists
	if (!existsSync(iloomDir)) {
		return true
	}

	// Check if either settings file has meaningful content
	const settingsPath = path.join(iloomDir, 'settings.json')
	const settingsLocalPath = path.join(iloomDir, 'settings.local.json')

	const hasSettings = await hasNonEmptySettings(settingsPath)
	const hasLocalSettings = await hasNonEmptySettings(settingsLocalPath)

	return !hasSettings && !hasLocalSettings
}

async function hasNonEmptySettings(filePath: string): Promise<boolean> {
	if (!existsSync(filePath)) return false
	try {
		const content = await readFile(filePath, 'utf-8')
		const parsed = JSON.parse(content)
		return Object.keys(parsed).length > 0
	} catch {
		return false
	}
}

/**
 * Launch interactive first-run setup via InitCommand
 * @param customMessage Optional custom message to pass to Claude instead of the default
 */
export async function launchFirstRunSetup(customMessage?: string): Promise<void> {
	logger.info('First-time project setup detected.')
	logger.info(
		'iloom will now launch an interactive configuration session with Claude.'
	)

	const { waitForKeypress } = await import('./prompt.js')
	await waitForKeypress('Press any key to start configuration...')

	const initCommand = new InitCommand()
	const defaultMessage = 'Help me configure iloom settings for this project. This is my first time using iloom here. Note: Your iloom command will execute once we are done with configuration changes.'
	await initCommand.execute(customMessage ?? defaultMessage)

	// Mark project as configured to prevent wizard from re-triggering
	// Use the same project root resolution as needsFirstRunSetup() for consistency
	const projectRoot = await getProjectRoot()
	logger.debug(`Marking project as configured at root: ${projectRoot}`)
	const firstRunManager = new FirstRunManager()
	await firstRunManager.markProjectAsConfigured(projectRoot)
	logger.debug(`Project marked as configured at root: ${projectRoot}`)

	logger.info('Configuration complete! Continuing with your original command...')
}
