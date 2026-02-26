import { describe, it, expect, vi } from 'vitest'
import fs from 'fs-extra'
import path from 'path'
import os from 'os'
import { migrations } from './index.js'
import { resolveGlobalGitignorePath, ensureGlobalGitignorePatterns } from '../utils/gitignore.js'

// Mock fs-extra
vi.mock('fs-extra')

// Mock gitignore utilities used by the 0.10.4 migration
vi.mock('../utils/gitignore.js', () => ({
  resolveGlobalGitignorePath: vi.fn(),
  ensureGlobalGitignorePatterns: vi.fn(),
  // Pass through ensureWorktreeGitignore as a no-op since it's not used by migrations
  ensureWorktreeGitignore: vi.fn(),
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

  describe('v0.10.3 global gitignore migration for .iloom/worktrees', () => {
    const expectedPath = path.join(os.homedir(), '.config', 'git', 'ignore')
    const pattern = '**/.iloom/worktrees'
    const migration = migrations.find(m => m.version === '0.10.3')

    it('should exist with correct description', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toBe('Add global gitignore for .iloom/worktrees directory')
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
      const existingContent = '# Existing\n**/.iloom/worktrees\n'
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(existingContent as any)

      await migration?.migrate()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })
  })

  describe('v0.10.4 remediation migration for global gitignore path', () => {
    const xdgDefault = path.join(os.homedir(), '.config', 'git', 'ignore')
    const migration = migrations.find(m => m.version === '0.10.4')

    it('should exist with correct description', () => {
      expect(migration).toBeDefined()
      expect(migration?.description).toBe('Remediate global gitignore path for users with custom core.excludesFile')
    })

    it('is a no-op when resolved path matches XDG default', async () => {
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(xdgDefault)

      await migration?.migrate()

      expect(fs.readFile).not.toHaveBeenCalled()
      expect(ensureGlobalGitignorePatterns).not.toHaveBeenCalled()
    })

    it('copies iloom patterns from XDG default to resolved path when they differ', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const xdgContent = '# Added by iloom CLI\n**/.iloom/settings.local.json\n**/.iloom/package.iloom.local.json\n**/.claude/agents/iloom-*\n**/.claude/skills/iloom-*\n'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(xdgContent as any)
      vi.mocked(ensureGlobalGitignorePatterns).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(fs.readFile).toHaveBeenCalledWith(xdgDefault, 'utf-8')
      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledWith([
        '**/.iloom/settings.local.json',
        '**/.iloom/package.iloom.local.json',
        '**/.claude/agents/iloom-*',
        '**/.claude/skills/iloom-*',
      ])
    })

    it('only copies patterns matching **/.iloom/ and **/.claude/ prefixes', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const xdgContent = '# Added by iloom CLI\n**/.iloom/settings.local.json\n*.log\nnode_modules/\n**/.claude/agents/iloom-*\n# some comment\n'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(xdgContent as any)
      vi.mocked(ensureGlobalGitignorePatterns).mockResolvedValue(undefined)

      await migration?.migrate()

      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledWith([
        '**/.iloom/settings.local.json',
        '**/.claude/agents/iloom-*',
      ])
    })

    it('is idempotent - ensureGlobalGitignorePatterns handles deduplication', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const xdgContent = '**/.iloom/settings.local.json\n'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(xdgContent as any)
      vi.mocked(ensureGlobalGitignorePatterns).mockResolvedValue(undefined)

      await migration?.migrate()

      // ensureGlobalGitignorePatterns is called with the patterns - it handles idempotency internally
      expect(ensureGlobalGitignorePatterns).toHaveBeenCalledWith(['**/.iloom/settings.local.json'])
    })

    it('handles XDG default file not existing (nothing to copy)', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      vi.mocked(fs.readFile).mockRejectedValue(enoentError)

      await migration?.migrate()

      expect(ensureGlobalGitignorePatterns).not.toHaveBeenCalled()
    })

    it('re-throws non-ENOENT errors when reading XDG default file', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      vi.mocked(fs.readFile).mockRejectedValue(permError)

      await expect(migration?.migrate()).rejects.toThrow('EACCES: permission denied')
      expect(ensureGlobalGitignorePatterns).not.toHaveBeenCalled()
    })

    it('handles XDG default file with no iloom patterns', async () => {
      const customPath = path.join(os.homedir(), '.gitignore_global')
      vi.mocked(resolveGlobalGitignorePath).mockResolvedValue(customPath)
      const xdgContent = '*.log\nnode_modules/\n.env\n'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readFile).mockResolvedValue(xdgContent as any)

      await migration?.migrate()

      expect(ensureGlobalGitignorePatterns).not.toHaveBeenCalled()
    })
  })

})
