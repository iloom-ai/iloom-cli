import { logger } from '../utils/logger.js'
import { generateBranchName } from '../utils/claude.js'

/**
 * Test command to demonstrate branch name generation.
 * Uses the default (non-bare) Claude launch path — the same path real
 * `il start` / `il finish` use for most users.
 */
export class TestBranchNameCommand {
  public async execute(options: { title?: string; description?: string }): Promise<void> {
    const title = options.title ?? 'Add dark mode support to settings page'
    const description = options.description ?? 'Users have requested a dark mode toggle in the settings page that persists across sessions.'

    logger.info('Testing Branch Name Generation\n')
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
