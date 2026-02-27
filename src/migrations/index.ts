import type { Migration } from '../lib/VersionMigrationManager.js'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { ensureGlobalGitignorePatterns, removeGlobalGitignorePattern } from '../utils/gitignore.js'
import { executeGitCommand } from '../utils/git.js'
import { getLogger } from '../utils/logger-context.js'

/**
 * Slugify a worktree path into a metadata filename.
 * Mirrors MetadataManager.slugifyPath() but kept inline so migrations
 * remain self-contained and don't depend on the full MetadataManager class.
 */
function slugifyWorktreePath(worktreePath: string): string {
  let slug = worktreePath.replace(/[/\\]+$/, '')
  slug = slug.replace(/[/\\]/g, '___')
  slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
  return `${slug}.json`
}

// Migration registry - add new migrations here in version order
// Each migration must be idempotent (safe to run multiple times)
export const migrations: Migration[] = [
  // v0.6.0 is the baseline - no migrations needed
  {
    version: '0.6.1',
    description: 'Add global gitignore for .iloom/settings.local.json',
    migrate: async (): Promise<void> => {
      const globalIgnorePath = path.join(os.homedir(), '.config', 'git', 'ignore')
      const pattern = '**/.iloom/settings.local.json'

      // Ensure directory exists
      await fs.ensureDir(path.dirname(globalIgnorePath))

      // Read existing content or empty string
      let content = ''
      try {
        content = await fs.readFile(globalIgnorePath, 'utf-8')
      } catch {
        // File doesn't exist - will create
      }

      // Check if pattern already exists (idempotent)
      if (content.includes(pattern)) {
        return
      }

      // Append pattern with comment
      const separator = content.endsWith('\n') || content === '' ? '' : '\n'
      const newContent = content + separator + '\n# Added by iloom CLI\n' + pattern + '\n'
      await fs.writeFile(globalIgnorePath, newContent, 'utf-8')
    }
  },
  {
    version: '0.7.1',
    description: 'Add global gitignore for .iloom/package.iloom.local.json',
    migrate: async (): Promise<void> => {
      const globalIgnorePath = path.join(os.homedir(), '.config', 'git', 'ignore')
      const pattern = '**/.iloom/package.iloom.local.json'

      // Ensure directory exists
      await fs.ensureDir(path.dirname(globalIgnorePath))

      // Read existing content or empty string
      let content = ''
      try {
        content = await fs.readFile(globalIgnorePath, 'utf-8')
      } catch {
        // File doesn't exist - will create
      }

      // Check if pattern already exists (idempotent)
      if (content.includes(pattern)) {
        return
      }

      // Append pattern with comment
      const separator = content.endsWith('\n') || content === '' ? '' : '\n'
      const newContent = content + separator + '\n# Added by iloom CLI\n' + pattern + '\n'
      await fs.writeFile(globalIgnorePath, newContent, 'utf-8')
    }
  },
  {
    version: '0.9.3',
    description: 'Add global gitignore for swarm mode agent and skill files',
    migrate: async (): Promise<void> => {
      const globalIgnorePath = path.join(os.homedir(), '.config', 'git', 'ignore')
      const agentPattern = '**/.claude/agents/iloom-*'
      const skillPattern = '**/.claude/skills/iloom-*'
      const mcpConfigPathPattern = '**/.claude/iloom-swarm-mcp-config-path'

      // Ensure directory exists
      await fs.ensureDir(path.dirname(globalIgnorePath))

      // Read existing content or empty string
      let content = ''
      try {
        content = await fs.readFile(globalIgnorePath, 'utf-8')
      } catch {
        // File doesn't exist - will create
      }

      // Check if patterns already exist (idempotent) - use agent pattern as sentinel
      if (content.includes(agentPattern)) {
        return
      }

      // Append both patterns with comment
      const separator = content.endsWith('\n') || content === '' ? '' : '\n'
      const newContent = content + separator + '\n# Added by iloom CLI\n' + agentPattern + '\n' + skillPattern + '\n' + mcpConfigPathPattern + '\n'
      await fs.writeFile(globalIgnorePath, newContent, 'utf-8')
    }
  },
  {
    version: '0.10.3',
    description: 'Remediate global gitignore path for custom core.excludesFile',
    migrate: async (): Promise<void> => {
      // All iloom patterns from this and previous migrations
      // Note: **/.iloom/worktrees was removed — worktrees now live outside the project
      // tree as sibling directories, so the gitignore entry is no longer needed.
      const allIloomPatterns = [
        '**/.iloom/settings.local.json',
        '**/.iloom/package.iloom.local.json',
        '**/.claude/agents/iloom-*',
        '**/.claude/skills/iloom-*',
        '**/.claude/iloom-swarm-mcp-config-path',
      ]

      // Ensure all patterns exist at the correctly resolved global gitignore path.
      // This remediates previous migrations that hardcoded the XDG default
      // (~/.config/git/ignore) — if the user has core.excludesFile set to a
      // different path, this writes all iloom patterns to the correct location.
      await ensureGlobalGitignorePatterns(allIloomPatterns)
    }
  },
  {
    version: '0.10.4',
    description: 'Move worktrees from .iloom/worktrees/ to sibling directory and clean up gitignore entries',
    migrate: async (): Promise<void> => {
      const logger = getLogger()

      // 1. Discover existing worktrees via metadata files in ~/.config/iloom-ai/looms/
      const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')
      if (!(await fs.pathExists(loomsDir))) return

      const files = await fs.readdir(loomsDir)
      const jsonFiles = files.filter(f => f.endsWith('.json'))

      // Collect metadata entries that reference old-style .iloom/worktrees/ paths
      const oldPathMarker = path.join('.iloom', 'worktrees') + path.sep
      const metadataToMigrate: Array<{ fileName: string; filePath: string; data: Record<string, unknown>; oldWorktreePath: string }> = []
      const projectPaths = new Set<string>()

      for (const fileName of jsonFiles) {
        const filePath = path.join(loomsDir, fileName)
        try {
          const data = await fs.readJson(filePath)
          const worktreePath = data.worktreePath as string | undefined
          if (worktreePath?.includes(oldPathMarker)) {
            metadataToMigrate.push({ fileName, filePath, data, oldWorktreePath: worktreePath })
            // Derive project path: everything before .iloom/worktrees/
            const iloomIdx = worktreePath.indexOf(path.join('.iloom', 'worktrees'))
            if (iloomIdx > 0) {
              projectPaths.add(worktreePath.substring(0, iloomIdx - 1))
            }
          }
        } catch (error) {
          logger.debug(`Failed to read metadata file ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 2. Move worktrees using git worktree move
      for (const entry of metadataToMigrate) {
        const { oldWorktreePath, data, filePath, fileName } = entry

        // Derive the project path and new worktree path
        const iloomIdx = oldWorktreePath.indexOf(path.join('.iloom', 'worktrees'))
        if (iloomIdx <= 0) continue

        const projectPath = oldWorktreePath.substring(0, iloomIdx - 1)
        const worktreeName = path.basename(oldWorktreePath)
        const newWorktreePath = path.join(
          path.dirname(projectPath),
          `${path.basename(projectPath)}-worktrees`,
          worktreeName
        )

        // Skip if already moved (idempotent)
        if (await fs.pathExists(newWorktreePath)) {
          logger.debug(`Worktree already at new location: ${newWorktreePath}`)
        } else if (await fs.pathExists(oldWorktreePath)) {
          // Ensure parent directory exists
          await fs.ensureDir(path.dirname(newWorktreePath))

          try {
            await executeGitCommand(['worktree', 'move', oldWorktreePath, newWorktreePath], { cwd: projectPath })
          } catch (error) {
            logger.warn(`Failed to move worktree ${oldWorktreePath}: ${error instanceof Error ? error.message : String(error)}`)
            continue // Skip this worktree but continue with others
          }
        } else {
          // Old path doesn't exist and new path doesn't exist — worktree may
          // have been removed externally. Update metadata anyway.
          logger.debug(`Worktree not found at old or new location: ${oldWorktreePath}`)
        }

        // 3. Update metadata: change worktreePath and rename the metadata file
        data.worktreePath = newWorktreePath
        const newSlug = slugifyWorktreePath(newWorktreePath)
        const newFilePath = path.join(loomsDir, newSlug)

        // Write updated data to new filename
        await fs.writeJson(newFilePath, data, { spaces: 2 })

        // Remove old file if the name changed
        if (fileName !== newSlug && await fs.pathExists(filePath)) {
          await fs.remove(filePath)
        }
      }

      // 4. Update parentLoom.worktreePath in ALL metadata files that reference old paths
      // Re-scan because we just renamed files
      const updatedFiles = await fs.readdir(loomsDir)
      const updatedJsonFiles = updatedFiles.filter(f => f.endsWith('.json'))

      for (const fileName of updatedJsonFiles) {
        const filePath = path.join(loomsDir, fileName)
        try {
          const data = await fs.readJson(filePath)
          const parentWorktreePath = data.parentLoom?.worktreePath as string | undefined
          if (parentWorktreePath?.includes(oldPathMarker)) {
            const iloomIdx = parentWorktreePath.indexOf(path.join('.iloom', 'worktrees'))
            if (iloomIdx > 0) {
              const parentProjectPath = parentWorktreePath.substring(0, iloomIdx - 1)
              const parentWorktreeName = path.basename(parentWorktreePath)
              data.parentLoom.worktreePath = path.join(
                path.dirname(parentProjectPath),
                `${path.basename(parentProjectPath)}-worktrees`,
                parentWorktreeName
              )
              await fs.writeJson(filePath, data, { spaces: 2 })
            }
          }
        } catch (error) {
          logger.debug(`Failed to update parentLoom in ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 5. Clean up: remove empty .iloom/worktrees/ directories for each project
      for (const projectPath of projectPaths) {
        const oldWorktreeDir = path.join(projectPath, '.iloom', 'worktrees')
        try {
          if (await fs.pathExists(oldWorktreeDir)) {
            const remaining = await fs.readdir(oldWorktreeDir)
            if (remaining.length === 0) {
              await fs.remove(oldWorktreeDir)
            }
          }
        } catch (error) {
          logger.debug(`Failed to clean up ${oldWorktreeDir}: ${error instanceof Error ? error.message : String(error)}`)
        }

        // 6. Remove .iloom/worktrees/ entries from project .gitignore
        const projectGitignore = path.join(projectPath, '.gitignore')
        try {
          if (await fs.pathExists(projectGitignore)) {
            const content = await fs.readFile(projectGitignore, 'utf-8')
            const lines = content.split('\n')
            const filteredLines = lines.filter(line => {
              const trimmed = line.trim()
              return trimmed !== '.iloom/worktrees/' && trimmed !== '.iloom/worktrees'
            })
            if (filteredLines.length !== lines.length) {
              await fs.writeFile(projectGitignore, filteredLines.join('\n'), 'utf-8')
            }
          }
        } catch (error) {
          logger.debug(`Failed to update .gitignore in ${projectPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // 7. Remove **/.iloom/worktrees from global gitignore
      await removeGlobalGitignorePattern('**/.iloom/worktrees')
    }
  },
]
