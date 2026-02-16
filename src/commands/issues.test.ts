import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'os'

// Mock fs-extra
vi.mock('fs-extra')

// Mock logger-context - use a stable singleton so tests can assert on logger calls
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}
vi.mock('../utils/logger-context.js', () => ({
  getLogger: () => mockLogger,
}))

// Mock github.ts
vi.mock('../utils/github.js', () => ({
  fetchGitHubIssueList: vi.fn(),
  fetchGitHubPRList: vi.fn(),
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
import { fetchGitHubIssueList, fetchGitHubPRList } from '../utils/github.js'
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
    // Default: no PRs (override in PR-specific tests)
    vi.mocked(fetchGitHubPRList).mockResolvedValue([])
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

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('123')
      expect(result[0].type).toBe('issue')
      expect(result[1].id).toBe('456')
      expect(result[1].type).toBe('issue')
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

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('ENG-101')
      expect(result[0].type).toBe('issue')
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

  describe('execute - GitHub provider with PRs', () => {
    const mockPRs: IssueListItem[] = [
      {
        id: '789',
        title: '[PR] Refactor auth module',
        updatedAt: '2026-02-09T10:00:00Z',
        url: 'https://github.com/org/repo/pull/789',
        state: 'open',
      },
    ]

    beforeEach(() => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
    })

    it('includes PRs with [PR] prefix and type field in results', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([
        { id: '123', title: 'Fix login bug', updatedAt: '2026-02-08T10:00:00Z', url: 'https://github.com/org/repo/issues/123', state: 'open' },
      ])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([...mockPRs])

      const mockSettingsManager = { loadSettings: vi.fn().mockResolvedValue({}) }
      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toHaveLength(2)

      const prItem = result.find(item => item.id === '789')
      expect(prItem).toBeDefined()
      expect(prItem!.title).toBe('[PR] Refactor auth module')
      expect(prItem!.type).toBe('pr')

      const issueItem = result.find(item => item.id === '123')
      expect(issueItem).toBeDefined()
      expect(issueItem!.type).toBe('issue')
    })

    it('sorts combined results by updatedAt descending', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([
        { id: '100', title: 'Old issue', updatedAt: '2026-02-01T10:00:00Z', url: 'https://github.com/org/repo/issues/100', state: 'open' },
      ])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([
        { id: '200', title: '[PR] New PR', updatedAt: '2026-02-09T10:00:00Z', url: 'https://github.com/org/repo/pull/200', state: 'open' },
      ])

      const mockSettingsManager = { loadSettings: vi.fn().mockResolvedValue({}) }
      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result[0].id).toBe('200') // PR is more recent, should be first
      expect(result[1].id).toBe('100')
    })

    it('applies limit to combined total after merging', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([
        { id: '1', title: 'Issue 1', updatedAt: '2026-02-05T10:00:00Z', url: 'https://github.com/org/repo/issues/1', state: 'open' },
        { id: '2', title: 'Issue 2', updatedAt: '2026-02-04T10:00:00Z', url: 'https://github.com/org/repo/issues/2', state: 'open' },
        { id: '3', title: 'Issue 3', updatedAt: '2026-02-03T10:00:00Z', url: 'https://github.com/org/repo/issues/3', state: 'open' },
      ])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([
        { id: '10', title: '[PR] PR 1', updatedAt: '2026-02-06T10:00:00Z', url: 'https://github.com/org/repo/pull/10', state: 'open' },
        { id: '11', title: '[PR] PR 2', updatedAt: '2026-02-02T10:00:00Z', url: 'https://github.com/org/repo/pull/11', state: 'open' },
      ])

      const mockSettingsManager = { loadSettings: vi.fn().mockResolvedValue({}) }
      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project', limit: 3 })

      expect(result).toHaveLength(3)
      // Should be the 3 most recently updated: PR 10 (Feb 6), Issue 1 (Feb 5), Issue 2 (Feb 4)
      expect(result.map(r => r.id)).toEqual(['10', '1', '2'])
    })

    it('continues with only issues if PR fetch fails with expected error', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([
        { id: '123', title: 'Fix login bug', updatedAt: '2026-02-08T10:00:00Z', url: 'https://github.com/org/repo/issues/123', state: 'open' },
      ])
      vi.mocked(fetchGitHubPRList).mockRejectedValue(new Error('gh: not logged in'))

      const mockSettingsManager = { loadSettings: vi.fn().mockResolvedValue({}) }
      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('123')
      expect(result[0].type).toBe('issue')
    })

    it('re-throws unexpected errors from PR fetch', async () => {
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([
        { id: '123', title: 'Fix login bug', updatedAt: '2026-02-08T10:00:00Z', url: 'https://github.com/org/repo/issues/123', state: 'open' },
      ])
      vi.mocked(fetchGitHubPRList).mockRejectedValue(new TypeError('Cannot read properties of undefined'))

      const mockSettingsManager = { loadSettings: vi.fn().mockResolvedValue({}) }
      const command = new IssuesCommand(mockSettingsManager as never)

      await expect(command.execute({ projectPath: '/my/project' })).rejects.toThrow(TypeError)
    })
  })

  describe('execute - Linear provider with PRs', () => {
    it('fetches PRs from GitHub even when provider is linear', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
      vi.mocked(fetchLinearIssueList).mockResolvedValue([
        { id: 'ENG-101', title: 'Implement search', updatedAt: '2026-02-08T10:00:00Z', url: 'https://linear.app/issue/ENG-101', state: 'In Progress' },
      ])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([
        { id: '500', title: '[PR] Fix CI pipeline', updatedAt: '2026-02-09T10:00:00Z', url: 'https://github.com/org/repo/pull/500', state: 'open' },
      ])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(fetchGitHubPRList).toHaveBeenCalledWith({ limit: 100, cwd: '/my/project' })
      expect(result).toHaveLength(2)

      const prItem = result.find(item => item.id === '500')
      expect(prItem).toBeDefined()
      expect(prItem!.type).toBe('pr')

      const linearItem = result.find(item => item.id === 'ENG-101')
      expect(linearItem).toBeDefined()
      expect(linearItem!.type).toBe('issue')
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

      // Verify the cache file contains correct data with type field
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(String(writeCall[1]))
      expect(writtenContent.data).toHaveLength(2)
      expect(writtenContent.data[0].type).toBe('issue')
      expect(writtenContent.provider).toBe('github')
      expect(writtenContent.projectPath).toBe('/my/project')
      expect(typeof writtenContent.timestamp).toBe('number')
    })

    it('reads and returns cached results when cache is within TTL', async () => {
      const cachedIssues = [
        { id: '123', title: 'Fix login bug', updatedAt: '2026-02-08T10:00:00Z', url: 'https://github.com/org/repo/issues/123', state: 'open', type: 'issue' as const },
        { id: '456', title: 'Add dark mode', updatedAt: '2026-02-07T10:00:00Z', url: 'https://github.com/org/repo/issues/456', state: 'open', type: 'issue' as const },
      ]
      const cachedData = {
        timestamp: Date.now() - 30_000, // 30 seconds ago, within 2-minute TTL
        projectPath: '/my/project',
        provider: 'github',
        data: cachedIssues,
      }

      vi.mocked(fs.existsSync).mockReturnValue(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs-extra readFile overloads conflict with mock types
      vi.mocked(fs.readFile).mockImplementation(() => Promise.resolve(JSON.stringify(cachedData)) as any)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      const result = await command.execute({ projectPath: '/my/project' })

      expect(result).toEqual(cachedIssues)
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

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('123')
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

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('123')
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
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('123')
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

  describe('execute - --mine flag', () => {
    it('passes mine option to fetchGitHubIssueList when provider is github', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue(mockGitHubIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(fetchGitHubIssueList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
        mine: true,
      })
    })

    it('passes mine option to fetchGitHubPRList when --mine is active', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(fetchGitHubPRList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
        mine: true,
      })
    })

    it('passes mine option to fetchLinearIssueList when provider is linear', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
      vi.mocked(fetchLinearIssueList).mockResolvedValue(mockLinearIssues)

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(fetchLinearIssueList).toHaveBeenCalledWith('ENG', { limit: 100, mine: true })
    })

    it('passes mine option to fetchGitHubPRList when provider is linear and --mine is active', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
      vi.mocked(fetchLinearIssueList).mockResolvedValue([])
      vi.mocked(fetchGitHubPRList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(fetchGitHubPRList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
        mine: true,
      })
    })

    it('does not warn when --mine used with github provider', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('does not warn when --mine used with linear provider', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
      vi.mocked(fetchLinearIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({
          issueManagement: { provider: 'linear', linear: { teamId: 'ENG' } },
        }),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', mine: true })

      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('warns only for --sprint with non-jira provider, not --mine', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project', sprint: 'current', mine: true })

      expect(mockLogger.warn).toHaveBeenCalledTimes(1)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--sprint'),
      )
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('--mine'),
      )
    })

    it('does not pass mine to fetch functions when mine is falsy', async () => {
      vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
      vi.mocked(fetchGitHubIssueList).mockResolvedValue([])

      const mockSettingsManager = {
        loadSettings: vi.fn().mockResolvedValue({}),
      }

      const command = new IssuesCommand(mockSettingsManager as never)
      await command.execute({ projectPath: '/my/project' })

      expect(fetchGitHubIssueList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
      })
      expect(fetchGitHubPRList).toHaveBeenCalledWith({
        limit: 100,
        cwd: '/my/project',
      })
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
