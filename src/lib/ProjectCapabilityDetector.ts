import fs from 'fs-extra'
import path from 'path'
import { getPackageConfig, parseBinField, hasWebDependencies, getExplicitCapabilities } from '../utils/package-json.js'
import type { ProjectCapability } from '../types/loom.js'

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

      // Monorepo detection: has pnpm-workspace.yaml or package.json workspaces field
      const pnpmWorkspacePath = path.join(worktreePath, 'pnpm-workspace.yaml')
      if (await fs.pathExists(pnpmWorkspacePath)) {
        capabilities.push('monorepo')
      } else if (pkgJson.workspaces) {
        capabilities.push('monorepo')
      }

      // Parse bin entries for CLI projects
      const binEntries = pkgJson.bin ? parseBinField(pkgJson.bin, pkgJson.name) : {}

      return { capabilities, binEntries }
    } catch (error) {
      // Handle missing package.json - return empty capabilities for non-Node.js projects
      if (error instanceof Error && error.message.includes('package.json not found')) {
        return { capabilities: [], binEntries: {} }
      }
      // Re-throw other errors (invalid JSON, etc.)
      throw error
    }
  }
}
