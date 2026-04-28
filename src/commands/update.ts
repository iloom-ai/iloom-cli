import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs-extra'
import { logger } from '../utils/logger.js'
import { detectInstallationMethod, isVoltaInstall } from '../utils/installation-detector.js'
import { UpdateNotifier } from '../utils/update-notifier.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export class UpdateCommand {
  async execute(options: { dryRun?: boolean } = {}): Promise<void> {
    // Check installation method - only allow updates for global installations
    const installMethod = detectInstallationMethod(__filename)
    logger.debug(`[update] Installation method detected: ${installMethod}`)

    if (installMethod !== 'global') {
      logger.error('Update command only works for globally installed iloom-cli')

      switch (installMethod) {
        case 'local':
          logger.info('You appear to be running from local development.')
          logger.info('To update: git pull origin main && pnpm install && pnpm build')
          break
        case 'linked':
          logger.info('You appear to be running from npm link.')
          logger.info('To update: cd to your local iloom repo and run git pull')
          break
        default:
          logger.info('Unable to determine installation method.')
          logger.info('If globally installed, try: npm install -g @iloom/cli@latest')
          logger.info('If installed via Volta, try: volta install @iloom/cli@latest')
          break
      }

      process.exit(1)
    }

    const voltaManaged = isVoltaInstall(__filename)
    logger.debug(`[update] Volta-managed install: ${voltaManaged}`)

    // Get current version from package.json
    const packageJsonPath = join(__dirname, '..', 'package.json')
    logger.debug(`[update] Reading package.json from: ${packageJsonPath}`)
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
    const currentVersion = packageJson.version
    const packageName = packageJson.name
    logger.debug(`[update] Current version: ${currentVersion}, package: ${packageName}`)

    // Check for available updates
    logger.info('🔍 Checking for updates...')
    const notifier = new UpdateNotifier(currentVersion, packageName)
    const updateResult = await notifier.checkForUpdates()
    logger.debug(`[update] Update check result: ${JSON.stringify(updateResult)}`)

    if (!updateResult) {
      logger.error('Failed to check for updates. Please try again later.')
      process.exit(1)
    }

    if (!updateResult.updateAvailable) {
      logger.success(`Already up to date! Current version: ${currentVersion}`)
      return
    }

    // Show update info and proceed
    logger.info(`Update available: ${updateResult.currentVersion} → ${updateResult.latestVersion}`)

    const updateCommand = voltaManaged ? 'volta' : 'npm'
    const updateArgs = voltaManaged
      ? ['install', `${packageName}@latest`]
      : ['install', '-g', `${packageName}@latest`]

    if (options.dryRun) {
      logger.info('🔍 DRY RUN - showing what would be done:')
      logger.info(`   Would run: ${updateCommand} ${updateArgs.join(' ')}`)
      logger.info(`   Current version: ${currentVersion}`)
      logger.info(`   Target version: ${updateResult.latestVersion}`)
      logger.debug(`[update] Dry run complete, skipping actual update`)
      return
    }

    if (voltaManaged && !isCommandAvailable('volta')) {
      logger.error('iloom appears to be installed under Volta (~/.volta/), but the `volta` command is not available on your PATH.')
      logger.info('')
      logger.info('Volta needs its shim directory on PATH to update packages. To fix:')
      logger.info('  1. Ensure ~/.volta/bin is on your PATH (Volta usually adds this during install).')
      logger.info('  2. Reload your shell: exec $SHELL -l')
      logger.info('  3. Verify with: which volta')
      logger.info('  4. If Volta was uninstalled, reinstall from https://volta.sh, or remove ~/.volta and reinstall iloom with: npm install -g @iloom/cli@latest')
      logger.info('')
      logger.info(`Once \`volta\` is available, re-run: il update  (or manually: volta install ${packageName}@latest)`)
      process.exit(1)
    }

    logger.info('🔄 Starting update...')

    const child = spawn(updateCommand, updateArgs, {
      stdio: 'inherit'
    })

    child.on('close', (code) => {
      if (code === 0) {
        logger.success('Update complete!')
      } else {
        logger.error(`Update failed with exit code ${code}`)
      }
      process.exit(code ?? 0)
    })
  }
}

function isCommandAvailable(cmd: string): boolean {
  const which = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(which, [cmd], { stdio: 'ignore' })
  return result.status === 0
}