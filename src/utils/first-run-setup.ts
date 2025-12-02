import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { logger } from './logger.js'

/**
 * Check if project needs first-run setup
 * Returns true if .iloom directory missing or settings files empty
 */
export async function needsFirstRunSetup(): Promise<boolean> {
	const iloomDir = path.join(process.cwd(), '.iloom')

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
 */
export async function launchFirstRunSetup(): Promise<void> {
	logger.info('First-time project setup detected.')
	logger.info(
		'iloom will now launch an interactive configuration session with Claude.'
	)

	const { waitForKeypress } = await import('./prompt.js')
	await waitForKeypress('Press any key to start configuration...')

	const { InitCommand } = await import('../commands/init.js')
	const initCommand = new InitCommand()
	await initCommand.execute(
		'Help me configure iloom settings for this project. This is my first time using iloom here. Note: Your iloom command will execute once we are done with configuration changes.'
	)

	logger.info('Configuration complete! Continuing with your original command...')
}
