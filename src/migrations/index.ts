import type { Migration } from '../lib/VersionMigrationManager.js'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { ensureGlobalGitignorePatterns } from '../utils/gitignore.js'

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
    description: 'Add global gitignore for .iloom/worktrees and remediate path for custom core.excludesFile',
    migrate: async (): Promise<void> => {
      // All iloom patterns from this and previous migrations
      const allIloomPatterns = [
        '**/.iloom/settings.local.json',
        '**/.iloom/package.iloom.local.json',
        '**/.claude/agents/iloom-*',
        '**/.claude/skills/iloom-*',
        '**/.claude/iloom-swarm-mcp-config-path',
        '**/.iloom/worktrees',
      ]

      // Ensure all patterns exist at the correctly resolved global gitignore path.
      // This both adds the new **/.iloom/worktrees pattern AND remediates previous
      // migrations that hardcoded the XDG default (~/.config/git/ignore) — if the
      // user has core.excludesFile set to a different path, this writes all iloom
      // patterns to the correct location.
      await ensureGlobalGitignorePatterns(allIloomPatterns)
    }
  },
]
