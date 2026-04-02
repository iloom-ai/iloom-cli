import { logger } from '../utils/logger.js'
import { resolveBareModeConfig, generateBranchName } from '../utils/claude.js'

/**
 * Test command to demonstrate bare mode branch name generation.
 * Shows whether bare mode is available and generates a sample branch name.
 */
export class TestBranchNameCommand {
  public async execute(options: { title?: string; description?: string }): Promise<void> {
    const title = options.title ?? 'Add dark mode support to settings page'
    const description = options.description ?? 'Users have requested a dark mode toggle in the settings page that persists across sessions.'

    logger.info('Testing Branch Name Generation (Bare Mode)\n')

    // Show bare mode resolution
    logger.info('Resolving bare mode configuration...')
    const config = await resolveBareModeConfig()

    if (config.bare && config.oauthToken) {
      logger.success('Using bare mode with OAuth token')
    } else if (config.bare) {
      logger.success('Using bare mode with API key')
    } else {
      logger.warn('Using standard mode (no bare)')
    }

    logger.info('')
    logger.info(`Title: ${title}`)
    logger.info(`Description: ${description}`)
    logger.info('Generating branch name...\n')

    const startTime = Date.now()
    const branchName = await generateBranchName(title, '999')
    const duration = Date.now() - startTime

    logger.success(`Branch name: ${branchName}`)
    logger.info(`Duration: ${duration}ms`)
  }
}
