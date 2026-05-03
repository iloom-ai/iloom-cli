import fs from 'fs-extra'
import path from 'path'
import { getPackageConfig, parseBinField, hasWebDependencies, hasIosDependencies, getExplicitCapabilities } from '../utils/package-json.js'
import type { PackageJson } from '../utils/package-json.js'
import type { ProjectCapability } from '../types/loom.js'
import { getLogger } from '../utils/logger-context.js'

export interface ProjectCapabilities {
  capabilities: ProjectCapability[]
  binEntries: Record<string, string>
}

export class ProjectCapabilityDetector {
  /**
   * Detect project capabilities by analyzing package configuration
   *
   * Detection priority:
   * 1. Explicit capabilities from package.iloom.json (for non-Node.js projects)
   * 2. Inferred capabilities from package.json (bin field, web dependencies)
   * 3. iOS detection from dependencies and filesystem markers (macOS only)
   *
   * @param worktreePath Path to the worktree directory
   * @returns Project capabilities and bin entries
   */
  async detectCapabilities(worktreePath: string): Promise<ProjectCapabilities> {
    try {
      const pkgJson = await getPackageConfig(worktreePath)

      // Check for explicit capabilities first (from package.iloom.json)
      const explicitCapabilities = getExplicitCapabilities(pkgJson)
      if (explicitCapabilities.length > 0) {
        // For non-Node.js projects with explicit capabilities,
        // binEntries is empty (no bin field parsing needed)
        return { capabilities: explicitCapabilities, binEntries: {} }
      }

      // Fall back to inferring capabilities from package.json
      const capabilities: ProjectCapability[] = []

      // CLI detection: has bin field
      if (pkgJson.bin) {
        capabilities.push('cli')
      }

      // Web detection: has web framework dependencies
      if (hasWebDependencies(pkgJson)) {
        capabilities.push('web')
      }

      // iOS detection: dependency-based and filesystem-based (macOS only)
      if (await this.detectIosCapability(worktreePath, pkgJson)) {
        capabilities.push('ios')
      }

      // Parse bin entries for CLI projects
      const binEntries = pkgJson.bin ? parseBinField(pkgJson.bin, pkgJson.name) : {}

      return { capabilities, binEntries }
    } catch (error) {
      // Handle missing package.json - return empty capabilities for non-Node.js projects
      if (error instanceof Error && error.message.includes('package.json not found')) {
        // Still check for iOS filesystem markers even without package.json
        const capabilities: ProjectCapability[] = []
        if (await this.detectIosCapability(worktreePath, null)) {
          capabilities.push('ios')
        }
        return { capabilities, binEntries: {} }
      }
      // Re-throw other errors (invalid JSON, etc.)
      throw error
    }
  }

  /**
   * Detect iOS capability from package dependencies and filesystem markers.
   * Only runs on macOS - logs a debug message and returns false on other platforms.
   *
   * @param worktreePath Path to the worktree directory
   * @param pkgJson Parsed package.json, or null if not available
   * @returns true if iOS markers are found on macOS
   */
  private async detectIosCapability(worktreePath: string, pkgJson: PackageJson | null): Promise<boolean> {
    if (process.platform !== 'darwin') {
      getLogger().debug('Skipping iOS detection: not running on macOS')
      return false
    }

    // Check dependency-based markers
    if (pkgJson && hasIosDependencies(pkgJson)) {
      return true
    }

    // Check filesystem-based markers
    return this.hasIosFilesystemMarkers(worktreePath)
  }

  /**
   * Check for iOS-specific filesystem markers in the project directory.
   * Looks for Xcode project files, Podfiles, and Expo config files.
   *
   * @param worktreePath Path to the worktree directory
   * @returns true if any iOS filesystem markers are found
   */
  private async hasIosFilesystemMarkers(worktreePath: string): Promise<boolean> {
    // Check for .xcodeproj or .xcworkspace in root and ios/ subdirectory
    const rootEntries = await this.readdirSafe(worktreePath)
    const iosSubdir = path.join(worktreePath, 'ios')
    const iosEntries = (await fs.pathExists(iosSubdir)) ? await this.readdirSafe(iosSubdir) : []
    const allEntries = [...rootEntries, ...iosEntries]
    const hasXcodeProject = allEntries.some(
      entry => entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace')
    )
    if (hasXcodeProject) {
      return true
    }

    // Check for Podfile in root
    if (await fs.pathExists(path.join(worktreePath, 'Podfile'))) {
      return true
    }

    // Check for Podfile in ios/ subdirectory
    if (await fs.pathExists(path.join(worktreePath, 'ios', 'Podfile'))) {
      return true
    }

    // Check for Expo config files — parse app.json to verify Expo-specific keys
    const appJsonPath = path.join(worktreePath, 'app.json')
    if (await fs.pathExists(appJsonPath)) {
      try {
        const content = await fs.readJson(appJsonPath)
        if (content?.expo || content?.ios) {
          return true
        }
      } catch {
        // Malformed JSON - skip this marker
      }
    }

    if (await fs.pathExists(path.join(worktreePath, 'app.config.js'))) {
      return true
    }

    return false
  }

  /**
   * Read directory entries, only swallowing ENOENT/ENOTDIR errors.
   * Permission errors and other unexpected errors are re-thrown.
   */
  private async readdirSafe(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath)
    } catch (error: unknown) {
      const isExpectedError =
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      if (!isExpectedError) {
        throw error
      }
      return []
    }
  }
}
