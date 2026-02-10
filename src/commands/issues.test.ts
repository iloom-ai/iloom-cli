import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'

// Mock fs-extra
vi.mock('fs-extra')

// Mock logger-context
vi.mock('../utils/logger-context.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// Mock github.ts
vi.mock('../utils/github.js', () => ({
  fetchGitHubIssueList: vi.fn(),
}))

// Mock linear.ts
vi.mock('../utils/linear.js', () => ({
  fetchLinearIssueList: vi.fn(),
}))

// Mock git.ts
vi.mock('../utils/git.js', () => ({
  findMainWorktreePathWithSettings: vi.fn(),
}))

// Mock SettingsManager
vi.mock('../lib/SettingsManager.js', () => ({
  SettingsManager: vi.fn().mockImplementation(() => ({
    loadSettings: vi.fn().mockResolvedValue({}),
  })),
}))

// Mock IssueTrackerFactory
vi.mock('../lib/IssueTrackerFactory.js', () => ({
  IssueTrackerFactory: {
    getProviderName: vi.fn().mockReturnValue('github'),
  },
}))

import fs from 'fs-extra'
import { IssuesCommand, type IssueListItem } from './issues.js'
import { fetchGitHubIssueList } from '../utils/github.js'
import { fetchLinearIssueList } from '../utils/linear.js'
import { findMainWorktreePathWithSettings } from '../utils/git.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'

const mockGitHubIssues: IssueListItem[] = [
  {
    id: '123',
    title: 'Fix login bug',
    updatedAt: '2026-02-08T10:00:00Z',
    url: 'https://github.com/org/repo/issues/123',
    state: 'open',
  },
  {
    id: '456',
    title: 'Add dark mode',
    updatedAt: '2026-02-07T10:00:00Z',
    url: 'https://github.com/org/repo/issues/456',
    state: 'open',
  },
]

const mockLinearIssues: IssueListItem[] = [
  {
    id: 'ENG-101',
    title: 'Implement search',
    updatedAt: '2026-02-08T10:00:00Z',
    url: 'https://linear.app/issue/ENG-101/implement-search',
    state: 'In Progress',
  },
]

describe('IssuesCommand', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user')
    // Default: no cache file
    vi.mocked(fs.existsSync).mockReturnValue(false)
    // Default: cache writes succeed
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
  })

  describe('execute - GitHub provider', () => {
    beforeEach(() => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
    })

    it('returns issues from GitHub when provider is github', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'github' },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(mockGitHubIssues)
      expect(fetchGitHubIssueList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
      })
    })

    it('passes limit option to fetchGitHubIssueList', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', limit: 50 })

      expect(fetchGitHubIssueList).toHaveBeenCalledWith({
        limit: 50,
        cwd: '/my/project',
      })
    })

    it('returns empty array when no issues found', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual([])
    })

    it('propagates GitHub API errors (no swallowing)', async () => {
      vi.mocked(fetchGitHubIssueList).mockRejectedValue(new Error('gh: not logged in'))

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await expect(command.execute({ projectPath: '/my/project' })).rejects.toThrow('gh: not logged in')
    })
  })

  describe('execute - Linear provider', () => {
    beforeEach(() => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
    })

    it('returns issues from Linear when provider is linear', async () => {
      vi.mocked(fetchLinearIssueList).mockResolvedValue(mockLinearIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(mockLinearIssues)
      expect(fetchLinearIssueList).toHaveBeenCalledWith('ENG', { limit: 100 })
    })

    it('passes apiToken from settings to fetchLinearIssueList', async () => {
      vi.mocked(fetchLinearIssueList).mockResolvedValue(mockLinearIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG', apiToken: 'lin_api_from_settings' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project' })

      expect(fetchLinearIssueList).toHaveBeenCalledWith('ENG', { limit: 100, apiToken: 'lin_api_from_settings' })
    })

    it('falls back to LINEAR_API_TOKEN env var when apiToken not in settings', async () => {
      const originalEnv = process.env.LINEAR_API_TOKEN
      process.env.LINEAR_API_TOKEN = 'lin_api_from_env'

      try {
        vi.mocked(fetchLinearIssueList).mockResolvedValue(mockLinearIssues)

        const mockSettingsManager = {
          loadSettings: vi.fn().mockResolvedValue({
            issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
          }),
        }

        const command = new IssuesCommand(mockSettingsManager as never)
        await command.execute({ projectPath: '/my/project' })

        expect(fetchLinearIssueList).toHaveBeenCalledWith('ENG', { limit: 100, apiToken: 'lin_api_from_env' })
      } finally {
        if (originalEnv === undefined) {
          delete process.env.LINEAR_API_TOKEN
        } else {
          process.env.LINEAR_API_TOKEN = originalEnv
        }
      }
    })

    it('passes limit and teamId to fetchLinearIssueList', async () => {
      vi.mocked(fetchLinearIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'PLAT' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', limit: 25 })

      expect(fetchLinearIssueList).toHaveBeenCalledWith('PLAT', { limit: 25 })
    })

    it('throws error for missing teamId', async () => {
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear' },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await expect(command.execute({ projectPath: '/my/project' })).rejects.toThrow(
        'Linear team ID not configured',
      )
    })

    it('propagates LinearServiceError for missing API token', async () => {
      vi.mocked(fetchLinearIssueList).mockRejectedValue(
        new Error('LINEAR_API_TOKEN not set'),
      )

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await expect(command.execute({ projectPath: '/my/project' })).rejects.toThrow(
        'LINEAR_API_TOKEN not set',
      )
    })
  })

  describe('file-based caching', () => {
    beforeEach(() => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
    })

    it('writes cache file after fresh fetch', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project' })

      expect(fs.ensureDir).toHaveBeenCalled()
      expect(fs.writeFile).toHaveBeenCalled()

      // Verify the cache file contains correct data
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(String(writeCall[1]))
      expect(writtenContent.data).toEqual(mockGitHubIssues)
      expect(writtenContent.provider).toBe('github')
      expect(writtenContent.projectPath).toBe('/my/project')
      expect(typeof writtenContent.timestamp).toBe('number')
    })

    it('reads and returns cached results when cache is within TTL', async () => {
      const cachedData = {
        timestamp: Date.now() - 30_000, // 30 seconds ago, within 2-minute TTL
        projectPath: '/my/project',
        provider: 'github',
        data: mockGitHubIssues,
      }

      vi.mocked(fs.existsSync).mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs-extra readFile overloads conflict with mock types
      vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(JSON.stringify(cachedData)) as any)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(mockGitHubIssues)
      // Should NOT have called the fetch function
      expect(fetchGitHubIssueList).not.toHaveBeenCalled()
    })

    it('fetches fresh results when cache is older than TTL', async () => {
      const cachedData = {
        timestamp: Date.now() - 3 * 60 * 1000, // 3 minutes ago, expired
        projectPath: '/my/project',
        provider: 'github',
        data: [{ id: 'old', title: 'Old issue', updatedAt: '2026-01-01T00:00:00Z', url: 'http://old', state: 'open' }],
      }

      vi.mocked(fs.existsSync).mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs-extra readFile overloads conflict with mock types
      vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(JSON.stringify(cachedData)) as any)
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(mockGitHubIssues)
      expect(fetchGitHubIssueList).toHaveBeenCalled()
    })

    it('fetches fresh results when cache file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(mockGitHubIssues)
      expect(fetchGitHubIssueList).toHaveBeenCalled()
    })

    it('handles corrupted cache file gracefully (treats as cache miss)', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs-extra readFile overloads conflict with mock types
      vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve('invalid json {]') as any)
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      // Should recover and fetch fresh
      expect(result).toEqual(mockGitHubIssues)
      expect(fetchGitHubIssueList).toHaveBeenCalled()
    })

    it('caches separately per project path and provider', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)

      // Execute for project A
      await command.execute({ projectPath: '/project-a' })
      // Execute for project B
      await command.execute({ projectPath: '/project-b' })

      // Both should have written cache files, but with different paths
      const writeCalls = vi.mocked(fs.writeFile).mock.calls
      expect(writeCalls.length).toBe(2)

      const pathA = String(writeCalls[0][0])
      const pathB = String(writeCalls[1][0])
      expect(pathA).not.toBe(pathB)

      // Both should be in the cache directory
      expect(pathA).toContain('cache/issues-')
      expect(pathB).toContain('cache/issues-')
    })
  })

  describe('project path resolution', () => {
    beforeEach(() => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])
    })

    it('uses provided projectPath argument', async () => {
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/explicit/path' })

      expect(mockSettingsManager.loadSettings).toHaveBeenCalledWith('/explicit/path')
      expect(findMainWorktreePathWithSettings).not.toHaveBeenCalled()
    })

    it('resolves project root from worktree when no path provided', async () => {
      vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue('/resolved/worktree/root')

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute()

      expect(findMainWorktreePathWithSettings).toHaveBeenCalled()
      expect(mockSettingsManager.loadSettings).toHaveBeenCalledWith('/resolved/worktree/root')
    })

    it('falls back to cwd when worktree resolution fails', async () => {
      vi.mocked(findMainWorktreePathWithSettings).mockRejectedValue(new Error('not a git repo'))

      const originalCwd = process.cwd()
      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute()

      expect(findMainWorktreePathWithSettings).toHaveBeenCalled()
      expect(mockSettingsManager.loadSettings).toHaveBeenCalledWith(originalCwd)
    })
  })
})
