import type { Migration } from '../lib/VersionMigrationManager.js'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { resolveGlobalGitignorePath, ensureGlobalGitignorePatterns } from '../utils/gitignore.js'

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
    description: 'Add global gitignore for .iloom/worktrees directory',
    migrate: async (): Promise<void> => {
      const globalIgnorePath = path.join(os.homedir(), '.config', 'git', 'ignore')
      const pattern = '**/.iloom/worktrees'

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
    version: '0.10.4',
    description: 'Remediate global gitignore path for users with custom core.excludesFile',
    migrate: async (): Promise<void> => {
      const resolvedPath = await resolveGlobalGitignorePath()
      const xdgDefault = path.join(os.homedir(), '.config', 'git', 'ignore')

      // If the resolved path matches the XDG default, previous migrations already
      // wrote to the correct location - nothing to remediate
      if (resolvedPath === xdgDefault) {
        return
      }

      // Read the XDG default file to find iloom patterns that were written there
      let xdgContent = ''
      try {
        xdgContent = await fs.readFile(xdgDefault, 'utf-8')
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          // XDG default file doesn't exist - nothing to copy
          return
        }
        throw error
      }

      // Extract iloom patterns by content prefix
      const lines = xdgContent.split('\n')
      const iloomPatterns = lines.filter(
        line => line.startsWith('**/.iloom/') || line.startsWith('**/.claude/')
      )

      if (iloomPatterns.length === 0) {
        return
      }

      // Append missing iloom patterns to the correctly resolved path
      await ensureGlobalGitignorePatterns(iloomPatterns)
    }
  },
]
