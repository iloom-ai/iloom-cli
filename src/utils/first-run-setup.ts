import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { logger } from './logger.js'
import { FirstRunManager } from './FirstRunManager.js'
import { getRepoRoot } from './git.js'
import { promptConfirmation, waitForKeypress } from './prompt.js'

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
 * Uses git repo root for path resolution to ensure consistent behavior
 * regardless of whether the CLI is run from a subdirectory or worktree
 */
export async function needsFirstRunSetup(): Promise<boolean> {
	const projectRoot = await getProjectRoot()
	const firstRunManager = new FirstRunManager()

	// Check if project is tracked as configured globally
	const isConfigured = await firstRunManager.isProjectConfigured(projectRoot)
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
 * Display default configuration values in a formatted box
 */
function displayDefaultsBox(): void {
	logger.info(chalk.bold('Default Configuration:'))
	logger.info('')
	logger.info(`  ${chalk.cyan('Main Branch:')}     main`)
	logger.info(`  ${chalk.cyan('IDE:')}             vscode`)
	logger.info(`  ${chalk.cyan('Issue Tracker:')}   GitHub Issues`)
	logger.info(`  ${chalk.cyan('Merge Mode:')}      local ${chalk.dim('(merge locally)')}`)
	logger.info(`  ${chalk.cyan('Base Port:')}       3000`)
}

/**
 * Launch interactive first-run setup via InitCommand
 * Shows defaults first, allows quick acceptance or full wizard
 */
export async function launchFirstRunSetup(): Promise<void> {
	logger.info('First-time project setup detected.')
	logger.info('')

	// Display the defaults
	displayDefaultsBox()

	logger.info('')

	// Import prompt utility

	// Ask if defaults are OK (default to Yes)
	const acceptDefaults = await promptConfirmation(
		'Are these defaults OK?',
		true  // default to true, so Enter accepts
	)

	if (acceptDefaults) {
		// User accepted defaults - just mark as configured
		const projectRoot = await getProjectRoot()
		const firstRunManager = new FirstRunManager()
		await firstRunManager.markProjectAsConfigured(projectRoot)
		logger.info(chalk.green('Configuration complete! Using defaults.'))
		logger.info('You can run `il init` anytime to customize settings.')
		return
	}

	// User declined - launch full wizard
	logger.info('')
	logger.info('iloom will now launch an interactive configuration session with Claude.')

	await waitForKeypress('Press any key to start configuration...')

	const { InitCommand } = await import('../commands/init.js')
	const initCommand = new InitCommand()
	await initCommand.execute(
		'Help me configure iloom settings for this project. This is my first time using iloom here. Note: Your iloom command will execute once we are done with configuration changes.'
	)
	// Note: InitCommand.execute() now handles markProjectAsConfigured() internally
	// when the guided init completes successfully

	logger.info('Configuration complete! Continuing with your original command...')
}
