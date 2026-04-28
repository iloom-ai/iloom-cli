import { dirname, join } from 'path'
import { existsSync, lstatSync, realpathSync } from 'fs'
import { logger } from './logger.js'

export type InstallationMethod = 'global' | 'local' | 'linked' | 'unknown'

/**
 * Detect how iloom-cli is installed
 * - global: npm install -g (in global node_modules)
 * - local: Running from source directory (has src/ sibling to dist/)
 * - linked: npm link (symlinked executable)
 * - unknown: Cannot determine
 */
export function detectInstallationMethod(scriptPath: string): InstallationMethod {
  logger.debug(`[installation-detector] Detecting installation method for: ${scriptPath}`)

  if (process.env.OVERRIDE_INSTALLATION_METHOD) {
    const overrideMethod = process.env.OVERRIDE_INSTALLATION_METHOD as InstallationMethod
    logger.debug(`[installation-detector] Override detected, returning: ${overrideMethod}`)
    return overrideMethod
  }

  try {
    // Check if the script is a symlink (npm link creates symlinks)
    try {
      const stats = lstatSync(scriptPath)
      if (stats.isSymbolicLink()) {
        logger.debug(`[installation-detector] Script is a symlink`)
        // Resolve symlink to check where it actually points
        const realPath = realpathSync(scriptPath)
        logger.debug(`[installation-detector] Symlink resolves to: ${realPath}`)
        // If the real path is in node_modules, it's a global install
        // Only return 'linked' if it points outside node_modules
        if (!realPath.includes('/node_modules/')) {
          logger.debug(`[installation-detector] Symlink points outside node_modules, classification: linked`)
          return 'linked'
        }
        logger.debug(`[installation-detector] Symlink points to node_modules, treating as potential global install`)
        // Otherwise, continue checking with the resolved path
        scriptPath = realPath
      }
    } catch {
      // If we can't stat it, continue to other checks
      logger.debug(`[installation-detector] Unable to stat script file, continuing to other checks`)
    }

    // Check if running from source directory
    // If the file is at dist/cli.js, check if src/ exists as a sibling
    if (scriptPath.includes('/dist/') || scriptPath.includes('\\dist\\')) {
      logger.debug(`[installation-detector] Script is in dist/ directory, checking for local development setup`)
      const distDir = dirname(scriptPath) // dist/
      const projectRoot = dirname(distDir) // project root
      const srcDir = join(projectRoot, 'src')
      const packageJsonPath = join(projectRoot, 'package.json')
      logger.debug(`[installation-detector] Looking for src/ at: ${srcDir}`)
      logger.debug(`[installation-detector] Looking for package.json at: ${packageJsonPath}`)

      // If src/ and package.json exist in parent, we're running from source
      if (existsSync(srcDir) && existsSync(packageJsonPath)) {
        logger.debug(`[installation-detector] Found src/ and package.json, classification: local`)
        return 'local'
      }
    }

    // Check if in global node_modules
    // Global installs are typically in:
    // - /usr/local/lib/node_modules/ (macOS/Linux)
    // - ~/.nvm/versions/node/*/lib/node_modules/ (NVM)
    // - C:\Users\*\AppData\Roaming\npm\node_modules\ (Windows)
    // - /opt/homebrew/lib/node_modules (Homebrew on Apple Silicon)
    const globalPatterns = [
      '/lib/node_modules/',
      '/.nvm/versions/node/',
      '/AppData/Roaming/npm/node_modules/',
      '/.local/lib/node_modules/',
    ]

    const normalizedPath = scriptPath.replace(/\\/g, '/')
    logger.debug(`[installation-detector] Checking global patterns against: ${normalizedPath}`)
    for (const pattern of globalPatterns) {
      if (normalizedPath.includes(pattern)) {
        logger.debug(`[installation-detector] Matched global pattern '${pattern}', classification: global`)
        return 'global'
      }
    }

    logger.debug(`[installation-detector] No patterns matched, classification: unknown`)
    return 'unknown'
  } catch (error) {
    logger.debug(`[installation-detector] Error during detection: ${error}, classification: unknown`)
    return 'unknown'
  }
}

/**
 * Determine if update notifications should be shown
 * Returns true only for global installations
 */
export function shouldShowUpdateNotification(method: InstallationMethod): boolean {
  return method === 'global'
}

/**
 * Detect whether the script is installed under Volta's tools directory.
 * Volta installs packages at ~/.volta/tools/image/packages/<pkg>/lib/node_modules/<pkg>/...
 * so a `/.volta/` segment in the resolved script path is a reliable signal.
 */
export function isVoltaInstall(scriptPath: string): boolean {
  let resolved = scriptPath
  try {
    resolved = realpathSync(scriptPath)
  } catch {
    // fall through with the original path
  }
  const normalized = resolved.replace(/\\/g, '/')
  return normalized.includes('/.volta/')
}
