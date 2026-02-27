import { describe, it, expect, vi } from 'vitest'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { migrations } from './index.js'
import { ensureGlobalGitignorePatterns, removeGlobalGitignorePattern } from '../utils/gitignore.js'
import { executeGitCommand } from '../utils/git.js'

// Mock fs-extra
vi.mock('fs-extra')

// Mock gitignore utilities
vi.mock('../utils/gitignore.js', () => ({
  ensureGlobalGitignorePatterns: vi.fn(),
  removeGlobalGitignorePattern: vi.fn(),
}))

// Mock git utilities
vi.mock('../utils/git.js', () => ({
  executeGitCommand: vi.fn(),
  GitCommandError: class GitCommandError extends Error {
    constructor(message: string, public readonly exitCode: number | undefined, public readonly stderr: string) {
      super(message)
      this.name = 'GitCommandError'
    }
  },
}))

// Mock logger-context
vi.mock('../utils/logger-context.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    isDebugEnabled: () => false,
  }),
}))

describe('migrations', () => {
  describe('v0.6.1 global gitignore migration', () => {
    // Use actual homedir for path expectations since os is not easily mockable
    const expectedPath = path.join(os.homedir(), '.config', 'git', 'ignore')
    const pattern = '**/.iloom/settings.local.json'
    const migration = migrations.find(m => m.version === '0.6.1')

    it('should exist', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toBe('Add global gitignore for .iloom/settings.local.json')
    })

    it('should create ~/.config/git/ignore if not exists', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.ensureDir).toHaveBeenCalledWith(path.dirname(expectedPath))
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        '\n# Added by iloom CLI\n' + pattern + '\n',
        'utf-8'
      )
    })

    it('should append pattern if not already present', async () => {
      const existingContent = '# Existing ignores\n*.log\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        existingContent + '\n# Added by iloom CLI\n' + pattern + '\n',
        'utf-8'
      )
    })

    it('should not duplicate if pattern exists', async () => {
      const existingContent = '# Existing\n**/.iloom/settings.local.json\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)

      await migration?.migrate()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    it('should create parent directory if not exists', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.ensureDir).toHaveBeenCalledWith(path.join(os.homedir(), '.config', 'git'))
    })

    it('should handle file without trailing newline', async () => {
      const existingContent = '*.log'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        existingContent + '\n\n# Added by iloom CLI\n' + pattern + '\n',
        'utf-8'
      )
    })
  })

  describe('v0.7.1 global gitignore migration for package.iloom.local.json', () => {
    const expectedPath = path.join(os.homedir(), '.config', 'git', 'ignore')
    const pattern = '**/.iloom/package.iloom.local.json'
    const migration = migrations.find(m => m.version === '0.7.1')

    it('should exist', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toBe('Add global gitignore for .iloom/package.iloom.local.json')
    })

    it('should create ~/.config/git/ignore if not exists', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.ensureDir).toHaveBeenCalledWith(path.dirname(expectedPath))
      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        '\n# Added by iloom CLI\n' + pattern + '\n',
        'utf-8'
      )
    })

    it('should append pattern if not already present', async () => {
      const existingContent = '# Existing ignores\n*.log\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        existingContent + '\n# Added by iloom CLI\n' + pattern + '\n',
        'utf-8'
      )
    })

    it('should not duplicate if pattern exists', async () => {
      const existingContent = '# Existing\n**/.iloom/package.iloom.local.json\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)

      await migration?.migrate()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    it('should be idempotent when run multiple times', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue('**/.iloom/package.iloom.local.json\n' as any)

      await migration?.migrate()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })
  })

  describe('v0.9.3 global gitignore migration for swarm mode', () => {
    const expectedPath = path.join(os.homedir(), '.config', 'git', 'ignore')
    const agentPattern = '**/.claude/agents/iloom-*'
    const skillPattern = '**/.claude/skills/iloom-*'
    const migration = migrations.find(m => m.version === '0.9.3')

    it('should exist with correct description', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toContain('swarm')
    })

    it('should create ~/.config/git/ignore if not exists', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.ensureDir).toHaveBeenCalledWith(path.dirname(expectedPath))
      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string
      expect(writtenContent).toContain(agentPattern)
      expect(writtenContent).toContain(skillPattern)
      expect(writtenContent).toContain('# Added by iloom CLI')
    })

    it('should append both patterns when not already present', async () => {
      const existingContent = '# Existing ignores\n*.log\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string
      expect(writtenContent).toContain(agentPattern)
      expect(writtenContent).toContain(skillPattern)
      expect(writtenContent.startsWith(existingContent)).toBe(true)
    })

    it('should not duplicate if agent pattern already exists', async () => {
      const existingContent = '# Added by iloom CLI\n**/.claude/agents/iloom-*\n**/.claude/skills/iloom-*\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)

      await migration?.migrate()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    it('should handle file without trailing newline', async () => {
      const existingContent = '*.log'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await migration?.migrate()

      const writtenContent = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string
      expect(writtenContent).toMatch(/^\*\.log\n/)
    })
  })

  describe('v0.10.3 global gitignore path remediation', () => {
    const migration = migrations.find(m => m.version === '0.10.3')

    const allIloomPatterns = [
      '**/.iloom/settings.local.json',
      '**/.iloom/package.iloom.local.json',
      '**/.claude/agents/iloom-*',
      '**/.claude/skills/iloom-*',
      '**/.claude/iloom-swarm-mcp-config-path',
    ]

    it('should exist with correct description', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toContain('core.excludesFile')
    })

    it('should not include **/.iloom/worktrees in patterns', () => {
      expect(migration?.description).not.toContain('.iloom/worktrees')
    })

    it('calls ensureGlobalGitignorePatterns with all iloom patterns (excluding worktrees)', async () => {
      vi.mocked(ensureGlobalGitignorePatterns).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledWith(allIloomPatterns)
    })

    it('is idempotent - ensureGlobalGitignorePatterns handles deduplication', async () => {
      vi.mocked(ensureGlobalGitignorePatterns).mockResolvedValue(undefined)

      await migration?.migrate()
      await migration?.migrate()

      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledTimes(2)
      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledWith(allIloomPatterns)
    })
  })

  describe('v0.10.4 worktree relocation migration', () => {
    const migration = migrations.find(m => m.version === '0.10.4')
    const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')

    it('should exist with correct description', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toContain('sibling directory')
      expect(migration?.description).toContain('gitignore')
    })

    it('should be idempotent -- skip if looms directory does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false as never)

      await migration?.migrate()

      expect(fs.readdir).not.toHaveBeenCalled()
      expect(executeGitCommand).not.toHaveBeenCalled()
    })

    it('should relocate worktrees from .iloom/worktrees/ to sibling directory using git worktree move', async () => {
      const oldWorktreePath = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const newWorktreePath = '/Users/dev/project-worktrees/feat-issue-42'
      const metadataSlug = '___Users___dev___project___-iloom___worktrees___feat-issue-42.json'
      const newMetadataSlug = '___Users___dev___project-worktrees___feat-issue-42.json'

      // Setup: looms dir exists with one metadata file
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        if (p === oldWorktreePath) return true as never
        if (p === newWorktreePath) return false as never
        // For project .gitignore
        if (p === '/Users/dev/project/.gitignore') return false as never
        // For .iloom/worktrees dir cleanup
        if (p === '/Users/dev/project/.iloom/worktrees') return true as never
        return false as never
      })

      // First readdir: initial scan of looms dir
      // Second readdir: re-scan after renaming metadata files
      // Third readdir: checking if .iloom/worktrees dir is empty
      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [metadataSlug] as never
        if (readdirCallCount === 2) return [newMetadataSlug] as never
        if (readdirCallCount === 3) return [] as never // empty dir for cleanup
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, metadataSlug)) {
          return {
            worktreePath: oldWorktreePath,
            branchName: 'feat/issue-42',
            projectPath: '/Users/dev/project',
          }
        }
        // Re-scan reads the new file
        if (p === path.join(loomsDir, newMetadataSlug)) {
          return {
            worktreePath: newWorktreePath,
            branchName: 'feat/issue-42',
            projectPath: '/Users/dev/project',
          }
        }
        return {}
      })

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(executeGitCommand).mockResolvedValue('')
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should call git worktree move
      expect(executeGitCommand).toHaveBeenCalledWith(
        ['worktree', 'move', oldWorktreePath, newWorktreePath],
        { cwd: '/Users/dev/project' }
      )

      // Should ensure parent dir exists
      expect(fs.ensureDir).toHaveBeenCalledWith('/Users/dev/project-worktrees')
    })

    it('should rename metadata files to match new worktree paths', async () => {
      const oldWorktreePath = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const metadataSlug = '___Users___dev___project___-iloom___worktrees___feat-issue-42.json'
      const newMetadataSlug = '___Users___dev___project-worktrees___feat-issue-42.json'

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        if (p === oldWorktreePath) return true as never
        if (p === '/Users/dev/project/.iloom/worktrees') return false as never
        if (p === '/Users/dev/project/.gitignore') return false as never
        // Old metadata file still exists (for removal)
        if (p === path.join(loomsDir, metadataSlug)) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [metadataSlug] as never
        if (readdirCallCount === 2) return [newMetadataSlug] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, metadataSlug)) {
          return { worktreePath: oldWorktreePath, branchName: 'feat/issue-42' }
        }
        if (p === path.join(loomsDir, newMetadataSlug)) {
          return { worktreePath: '/Users/dev/project-worktrees/feat-issue-42', branchName: 'feat/issue-42' }
        }
        return {}
      })

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(executeGitCommand).mockResolvedValue('')
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should write updated metadata to new filename
      expect(fs.writeJson).toHaveBeenCalledWith(
        path.join(loomsDir, newMetadataSlug),
        expect.objectContaining({
          worktreePath: '/Users/dev/project-worktrees/feat-issue-42',
        }),
        { spaces: 2 }
      )

      // Should remove old metadata file
      expect(fs.remove).toHaveBeenCalledWith(path.join(loomsDir, metadataSlug))
    })

    it('should update parentLoom.worktreePath in child metadata files', async () => {
      const parentOldPath = '/Users/dev/project/.iloom/worktrees/feat-epic-10'
      const parentNewPath = '/Users/dev/project-worktrees/feat-epic-10'
      const childMetadataSlug = '___Users___dev___project-worktrees___fix-issue-11.json'

      // No worktrees to move (parent already handled), but child has stale parentLoom
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        // First scan: no old-style worktree metadata
        if (readdirCallCount === 1) return [] as never
        // Re-scan: find child metadata
        if (readdirCallCount === 2) return [childMetadataSlug] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, childMetadataSlug)) {
          return {
            worktreePath: '/Users/dev/project-worktrees/fix-issue-11',
            branchName: 'fix/issue-11',
            parentLoom: {
              type: 'epic',
              identifier: 10,
              branchName: 'feat/epic-10',
              worktreePath: parentOldPath,
            },
          }
        }
        return {}
      })

      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should update parentLoom.worktreePath
      expect(fs.writeJson).toHaveBeenCalledWith(
        path.join(loomsDir, childMetadataSlug),
        expect.objectContaining({
          parentLoom: expect.objectContaining({
            worktreePath: parentNewPath,
          }),
        }),
        { spaces: 2 }
      )
    })

    it('should remove .iloom/worktrees/ from project .gitignore if present', async () => {
      const oldWorktreePath = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const metadataSlug = 'old-slug.json'
      const newMetadataSlug = '___Users___dev___project-worktrees___feat-issue-42.json'

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        if (p === oldWorktreePath) return true as never
        if (p === '/Users/dev/project/.gitignore') return true as never
        if (p === '/Users/dev/project/.iloom/worktrees') return false as never
        if (p === path.join(loomsDir, metadataSlug)) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [metadataSlug] as never
        if (readdirCallCount === 2) return [newMetadataSlug] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, metadataSlug)) {
          return { worktreePath: oldWorktreePath, branchName: 'feat/issue-42' }
        }
        if (p === path.join(loomsDir, newMetadataSlug)) {
          return { worktreePath: '/Users/dev/project-worktrees/feat-issue-42' }
        }
        return {}
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue('node_modules/\n.iloom/worktrees/\ndist/\n' as any)
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(executeGitCommand).mockResolvedValue('')
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should write .gitignore without .iloom/worktrees/ line
      expect(fs.writeFile).toHaveBeenCalledWith(
        '/Users/dev/project/.gitignore',
        'node_modules/\ndist/\n',
        'utf-8'
      )
    })

    it('should remove **/.iloom/worktrees from global gitignore', async () => {
      // Minimal setup: looms dir exists but no metadata files
      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        return false as never
      })

      vi.mocked(fs.readdir).mockResolvedValue([] as never)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(removeGlobalGitignorePattern).toHaveBeenCalledWith('**/.iloom/worktrees')
    })

    it('should clean up empty .iloom/worktrees/ directory', async () => {
      const oldWorktreePath = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const metadataSlug = 'old-slug.json'
      const newMetadataSlug = '___Users___dev___project-worktrees___feat-issue-42.json'

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        if (p === oldWorktreePath) return true as never
        if (p === '/Users/dev/project/.iloom/worktrees') return true as never
        if (p === '/Users/dev/project/.gitignore') return false as never
        if (p === path.join(loomsDir, metadataSlug)) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [metadataSlug] as never
        if (readdirCallCount === 2) return [newMetadataSlug] as never
        // Empty dir for cleanup check
        if (readdirCallCount === 3) return [] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, metadataSlug)) {
          return { worktreePath: oldWorktreePath, branchName: 'feat/issue-42' }
        }
        if (p === path.join(loomsDir, newMetadataSlug)) {
          return { worktreePath: '/Users/dev/project-worktrees/feat-issue-42' }
        }
        return {}
      })

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(executeGitCommand).mockResolvedValue('')
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should remove the empty .iloom/worktrees/ directory
      expect(fs.remove).toHaveBeenCalledWith('/Users/dev/project/.iloom/worktrees')
    })

    it('should handle git worktree move failure gracefully and continue with other worktrees', async () => {
      const oldPath1 = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const oldPath2 = '/Users/dev/project/.iloom/worktrees/fix-issue-43'
      const slug1 = 'slug1.json'
      const slug2 = 'slug2.json'
      const newSlug2 = '___Users___dev___project-worktrees___fix-issue-43.json'

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        if (p === oldPath1) return true as never
        if (p === oldPath2) return true as never
        if (p === '/Users/dev/project/.iloom/worktrees') return false as never
        if (p === '/Users/dev/project/.gitignore') return false as never
        if (p === path.join(loomsDir, slug1)) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [slug1, slug2] as never
        if (readdirCallCount === 2) return [slug1, newSlug2] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, slug1)) {
          return { worktreePath: oldPath1, branchName: 'feat/issue-42' }
        }
        if (p === path.join(loomsDir, slug2)) {
          return { worktreePath: oldPath2, branchName: 'fix/issue-43' }
        }
        if (p === path.join(loomsDir, newSlug2)) {
          return { worktreePath: '/Users/dev/project-worktrees/fix-issue-43' }
        }
        return {}
      })

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // First git worktree move fails, second succeeds
      vi.mocked(executeGitCommand)
        .mockRejectedValueOnce(new Error('fatal: worktree is dirty'))
        .mockResolvedValueOnce('')
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      // Should not throw
      await migration?.migrate()

      // git worktree move should have been called twice (once for each worktree)
      expect(executeGitCommand).toHaveBeenCalledTimes(2)

      // Second worktree's metadata should still be written (the successful one)
      expect(fs.writeJson).toHaveBeenCalledWith(
        path.join(loomsDir, newSlug2),
        expect.objectContaining({
          worktreePath: '/Users/dev/project-worktrees/fix-issue-43',
        }),
        { spaces: 2 }
      )
    })

    it('should skip already-moved worktrees (idempotent)', async () => {
      const oldWorktreePath = '/Users/dev/project/.iloom/worktrees/feat-issue-42'
      const newWorktreePath = '/Users/dev/project-worktrees/feat-issue-42'
      const metadataSlug = 'old-slug.json'
      const newMetadataSlug = '___Users___dev___project-worktrees___feat-issue-42.json'

      vi.mocked(fs.pathExists).mockImplementation(async (p: string) => {
        if (p === loomsDir) return true as never
        // New path already exists (already moved)
        if (p === newWorktreePath) return true as never
        if (p === oldWorktreePath) return false as never
        if (p === '/Users/dev/project/.iloom/worktrees') return false as never
        if (p === '/Users/dev/project/.gitignore') return false as never
        if (p === path.join(loomsDir, metadataSlug)) return true as never
        return false as never
      })

      let readdirCallCount = 0
      vi.mocked(fs.readdir).mockImplementation(async () => {
        readdirCallCount++
        if (readdirCallCount === 1) return [metadataSlug] as never
        if (readdirCallCount === 2) return [newMetadataSlug] as never
        return [] as never
      })

      vi.mocked(fs.readJson).mockImplementation(async (p: string) => {
        if (p === path.join(loomsDir, metadataSlug)) {
          return { worktreePath: oldWorktreePath, branchName: 'feat/issue-42' }
        }
        if (p === path.join(loomsDir, newMetadataSlug)) {
          return { worktreePath: newWorktreePath }
        }
        return {}
      })

      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.writeJson).mockResolvedValue(undefined)
      vi.mocked(fs.remove).mockResolvedValue(undefined)
      vi.mocked(removeGlobalGitignorePattern).mockResolvedValue(undefined)

      await migration?.migrate()

      // Should NOT call git worktree move since it's already at the new location
      expect(executeGitCommand).not.toHaveBeenCalled()

      // Should still update metadata file (rename + update path)
      expect(fs.writeJson).toHaveBeenCalledWith(
        path.join(loomsDir, newMetadataSlug),
        expect.objectContaining({
          worktreePath: newWorktreePath,
        }),
        { spaces: 2 }
      )
    })
  })

})
