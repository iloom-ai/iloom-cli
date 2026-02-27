import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetadataManager } from './MetadataManager.js'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import type { ProjectCapability } from '../types/loom.js'

// Mock fs-extra
vi.mock('fs-extra')

// Mock logger to avoid console output during tests
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('MetadataManager', () => {
  let manager: MetadataManager
  const mockHomedir = '/Users/testuser'
  const expectedLoomsDir = '/Users/testuser/.config/iloom-ai/looms'

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(mockHomedir)
    manager = new MetadataManager()
  })

  describe('slugifyPath', () => {
    it('should convert absolute path to slug with double underscores', () => {
      const result = manager.slugifyPath('/Users/jane/dev/repo')
      expect(result).toBe('___Users___jane___dev___repo.json')
    })

    it('should trim trailing slashes before slugifying', () => {
      const result = manager.slugifyPath('/Users/jane/dev/repo/')
      expect(result).toBe('___Users___jane___dev___repo.json')
    })

    it('should handle multiple trailing slashes', () => {
      const result = manager.slugifyPath('/Users/jane/dev/repo///')
      expect(result).toBe('___Users___jane___dev___repo.json')
    })

    it('should replace non-alphanumeric chars (except _ and -) with hyphens', () => {
      // Spaces and special characters should become hyphens
      const result = manager.slugifyPath('/Users/jane doe/my project!')
      expect(result).toBe('___Users___jane-doe___my-project-.json')
    })

    it('should preserve underscores and hyphens in path', () => {
      const result = manager.slugifyPath('/Users/jane/my_project-v2')
      expect(result).toBe('___Users___jane___my_project-v2.json')
    })

    it('should handle Windows-style backslashes', () => {
      const result = manager.slugifyPath('C:\\Users\\jane\\dev\\repo')
      expect(result).toBe('C-___Users___jane___dev___repo.json')
    })

    it('should handle mixed path separators', () => {
      const result = manager.slugifyPath('/Users/jane\\dev/repo')
      expect(result).toBe('___Users___jane___dev___repo.json')
    })

    it('should produce consistent output for same input', () => {
      const path = '/Users/adam/Documents/Projects/my-loom'
      const result1 = manager.slugifyPath(path)
      const result2 = manager.slugifyPath(path)
      expect(result1).toBe(result2)
    })
  })

  describe('writeMetadata', () => {
    const worktreePath = '/Users/jane/dev/repo'
    const metadataInput = {
      description: 'Add dark mode toggle feature',
      branchName: 'issue-42__dark-mode',
      worktreePath: '/Users/jane/dev/repo',
      issueType: 'issue' as const,
      issue_numbers: ['42'],
      pr_numbers: [],
      issueTracker: 'github',
      colorHex: '#dcebff',
      sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      projectPath: '/Users/jane/dev/main-repo',
      issueUrls: { '42': 'https://github.com/org/repo/issues/42' },
      prUrls: {},
      capabilities: [] as ProjectCapability[],
    }

    beforeEach(() => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
    })

    it('should create looms directory if not exists', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      expect(fs.ensureDir).toHaveBeenCalledWith(expectedLoomsDir, { mode: 0o755 })
    })

    it('should write JSON with all metadata fields', async () => {
      // Mock Date.now to get consistent timestamp
      const mockDate = new Date('2024-01-15T10:30:00.000Z')
      vi.setSystemTime(mockDate)

      await manager.writeMetadata(worktreePath, metadataInput)

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.json'),
        expect.stringMatching(/"description":\s*"Add dark mode toggle feature"/),
        { mode: 0o644 }
      )

      // Verify the written content structure
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent).toMatchObject({
        description: 'Add dark mode toggle feature',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__dark-mode',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#dcebff',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        projectPath: '/Users/jane/dev/main-repo',
        issueUrls: { '42': 'https://github.com/org/repo/issues/42' },
        prUrls: {},
        capabilities: [],
      })

      vi.useRealTimers()
    })

    it('should write projectPath to JSON file', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.projectPath).toBe('/Users/jane/dev/main-repo')
    })

    it('should write issueUrls and prUrls to JSON file', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.issueUrls).toEqual({ '42': 'https://github.com/org/repo/issues/42' })
      expect(writtenContent.prUrls).toEqual({})
    })

    it('should use correct filename from slugified worktree path', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const expectedFilename = '___Users___jane___dev___repo.json'
      const expectedPath = path.join(expectedLoomsDir, expectedFilename)
      expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), expect.any(Object))
    })

    it('should not throw on write error', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Permission denied'))

      // Should not throw
      await expect(manager.writeMetadata(worktreePath, metadataInput)).resolves.not.toThrow()
    })

    it('should always include issueTracker field in written file', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.issueTracker).toBe('github')
    })

    it('should write sessionId to JSON file', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.sessionId).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    })

    it('should write parentLoom fields when provided', async () => {
      const inputWithParent = {
        ...metadataInput,
        parentLoom: {
          type: 'issue' as const,
          identifier: 100,
          branchName: 'issue-100__parent-feature',
          worktreePath: '/Users/jane/dev/parent-repo',
          databaseBranch: 'db-branch-100',
        },
      }

      await manager.writeMetadata(worktreePath, inputWithParent)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.parentLoom).toEqual({
        type: 'issue',
        identifier: 100,
        branchName: 'issue-100__parent-feature',
        worktreePath: '/Users/jane/dev/parent-repo',
        databaseBranch: 'db-branch-100',
      })
    })

    it('should not include parentLoom field when not provided', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.parentLoom).toBeUndefined()
    })

    it('should write capabilities array to metadata', async () => {
      const inputWithCapabilities = {
        ...metadataInput,
        capabilities: ['cli', 'web'] as ProjectCapability[],
      }

      await manager.writeMetadata(worktreePath, inputWithCapabilities)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.capabilities).toEqual(['cli', 'web'])
    })

    it('should write empty capabilities array when no capabilities detected', async () => {
      const inputWithEmptyCapabilities = {
        ...metadataInput,
        capabilities: [] as ProjectCapability[],
      }

      await manager.writeMetadata(worktreePath, inputWithEmptyCapabilities)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.capabilities).toEqual([])
    })

    it('should write oneShot mode to metadata when provided', async () => {
      const inputWithOneShot = {
        ...metadataInput,
        oneShot: 'noReview' as const,
      }

      await manager.writeMetadata(worktreePath, inputWithOneShot)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.oneShot).toBe('noReview')
    })

    it('should write bypassPermissions oneShot mode to metadata', async () => {
      const inputWithBypassPermissions = {
        ...metadataInput,
        oneShot: 'bypassPermissions' as const,
      }

      await manager.writeMetadata(worktreePath, inputWithBypassPermissions)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.oneShot).toBe('bypassPermissions')
    })

    it('should not include oneShot field when not provided', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.oneShot).toBeUndefined()
    })

    it('should write state to metadata when provided', async () => {
      const inputWithState = {
        ...metadataInput,
        state: 'in_progress' as const,
      }

      await manager.writeMetadata(worktreePath, inputWithState)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.state).toBe('in_progress')
    })

    it('should not include state field when not provided', async () => {
      await manager.writeMetadata(worktreePath, metadataInput)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.state).toBeUndefined()
    })

    it('should write issueType epic and childIssueNumbers to metadata when provided', async () => {
      const inputWithEpic = {
        ...metadataInput,
        issueType: 'epic' as const,
        childIssueNumbers: ['101', '102', '103'],
      }

      await manager.writeMetadata(worktreePath, inputWithEpic)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.issueType).toBe('epic')
      expect(writtenContent.childIssueNumbers).toEqual(['101', '102', '103'])
    })

    it('should not include childIssueNumbers when array is empty', async () => {
      const inputWithEmptyChildren = {
        ...metadataInput,
        childIssueNumbers: [],
      }

      await manager.writeMetadata(worktreePath, inputWithEmptyChildren)

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.childIssueNumbers).toBeUndefined()
    })
  })

  describe('readMetadata', () => {
    const worktreePath = '/Users/jane/dev/repo'

    it('should return metadata object with all fields from JSON file', async () => {
      const mockContent = JSON.stringify({
        description: 'Fix authentication bug',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__auth-fix',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        projectPath: '/Users/jane/dev/main-repo',
        issueUrls: { '42': 'https://github.com/org/repo/issues/42' },
        prUrls: {},
        capabilities: ['web'],
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result).toEqual({
        description: 'Fix authentication bug',
        created_at: '2024-01-15T10:30:00.000Z',
        branchName: 'issue-42__auth-fix',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issueKey: null,
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        projectPath: '/Users/jane/dev/main-repo',
        issueUrls: { '42': 'https://github.com/org/repo/issues/42' },
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        complexity: null,
        capabilities: ['web'],
        state: null,
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })
    })

    it('should return projectPath when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Test loom',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        projectPath: '/Users/jane/dev/main-repo',
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.projectPath).toBe('/Users/jane/dev/main-repo')
    })

    it('should return issueType epic and childIssueNumbers when present in metadata', async () => {
      const mockContent = JSON.stringify({
        description: 'Epic loom',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        issueType: 'epic',
        childIssueNumbers: ['101', '102'],
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.issueType).toBe('epic')
      expect(result?.childIssueNumbers).toEqual(['101', '102'])
    })

    it('should default childIssueNumbers to empty for legacy looms', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without epic fields',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.issueType).toBeNull()
      expect(result?.childIssueNumbers).toEqual([])
    })

    it('should return null projectPath for legacy looms', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without projectPath',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__legacy',
        worktreePath: '/Users/jane/dev/repo',
        // Note: no projectPath field
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.projectPath).toBeNull()
    })

    it('should return issueUrls/prUrls when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Test loom',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        issueUrls: { '123': 'https://github.com/org/repo/issues/123' },
        prUrls: { '456': 'https://github.com/org/repo/pull/456' },
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.issueUrls).toEqual({ '123': 'https://github.com/org/repo/issues/123' })
      expect(result?.prUrls).toEqual({ '456': 'https://github.com/org/repo/pull/456' })
    })

    it('should return empty issueUrls/prUrls for legacy looms', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without issueUrls/prUrls',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__legacy',
        worktreePath: '/Users/jane/dev/repo',
        // Note: no issueUrls/prUrls fields
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)
      expect(result?.issueUrls).toEqual({})
      expect(result?.prUrls).toEqual({})
    })

    it('should return null values for missing optional fields (v1 file)', async () => {
      const mockContent = JSON.stringify({
        description: 'Fix authentication bug',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result).toEqual({
        description: 'Fix authentication bug',
        created_at: '2024-01-15T10:30:00.000Z',
        branchName: null,
        worktreePath: null,
        issueType: null,
        issueKey: null,
        issue_numbers: [],
        pr_numbers: [],
        issueTracker: null,
        colorHex: null,
        sessionId: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        complexity: null,
        capabilities: [],
        state: null,
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })
    })

    it('should return null sessionId for legacy files without sessionId', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without sessionId',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__legacy',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        // Note: no sessionId field
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.sessionId).toBeNull()
    })

    it('should return null if file does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      const result = await manager.readMetadata(worktreePath)

      expect(result).toBeNull()
      expect(fs.readFile).not.toHaveBeenCalled()
    })

    it('should return null if JSON is invalid', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue('invalid json {{{')

      const result = await manager.readMetadata(worktreePath)

      expect(result).toBeNull()
    })

    it('should return null if description field is missing', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: 1 }))

      const result = await manager.readMetadata(worktreePath)

      expect(result).toBeNull()
    })

    it('should return null on read error', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Permission denied'))

      const result = await manager.readMetadata(worktreePath)

      expect(result).toBeNull()
    })

    it('should return parentLoom when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Child loom with parent',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-200__child-feature',
        worktreePath: '/Users/jane/dev/child-repo',
        issueType: 'issue',
        issue_numbers: ['200'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: 'issue-100__parent-feature',
          worktreePath: '/Users/jane/dev/parent-repo',
          databaseBranch: 'db-branch-100',
        },
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.parentLoom).toEqual({
        type: 'issue',
        identifier: 100,
        branchName: 'issue-100__parent-feature',
        worktreePath: '/Users/jane/dev/parent-repo',
        databaseBranch: 'db-branch-100',
      })
    })

    it('should return null parentLoom for non-child looms', async () => {
      const mockContent = JSON.stringify({
        description: 'Regular loom without parent',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        // Note: no parentLoom field
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.parentLoom).toBeNull()
    })

    it('should return capabilities array when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Loom with capabilities',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        capabilities: ['cli', 'web'],
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.capabilities).toEqual(['cli', 'web'])
    })

    it('should return empty capabilities array for legacy looms without capabilities field', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without capabilities',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__legacy',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        // Note: no capabilities field
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.capabilities).toEqual([])
    })

    it('should return oneShot when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Loom with oneShot',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        oneShot: 'noReview',
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.oneShot).toBe('noReview')
    })

    it('should return bypassPermissions oneShot when stored', async () => {
      const mockContent = JSON.stringify({
        description: 'Loom with bypassPermissions',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        oneShot: 'bypassPermissions',
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.oneShot).toBe('bypassPermissions')
    })

    it('should return null oneShot for legacy looms without oneShot field', async () => {
      const mockContent = JSON.stringify({
        description: 'Legacy loom without oneShot',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__legacy',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        // Note: no oneShot field
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.oneShot).toBeNull()
    })

    it('should return state when present in metadata file', async () => {
      const mockContent = JSON.stringify({
        description: 'Loom with swarm state',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
        state: 'code_review',
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.state).toBe('code_review')
    })

    it('should return null state for looms without state field', async () => {
      const mockContent = JSON.stringify({
        description: 'Loom without state',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#f5dceb',
      })
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(mockContent)

      const result = await manager.readMetadata(worktreePath)

      expect(result?.state).toBeNull()
    })
  })

  describe('listAllMetadata', () => {
    it('should return empty array when looms directory does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      const result = await manager.listAllMetadata()

      expect(result).toEqual([])
      expect(fs.readdir).not.toHaveBeenCalled()
    })

    it('should return empty array when looms directory is empty', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([])

      const result = await manager.listAllMetadata()

      expect(result).toEqual([])
    })

    it('should return metadata from all valid JSON files', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        '___Users___alice___project1.json',
        '___Users___bob___project2.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const path = String(filePath)
        if (path.includes('project1')) {
          return JSON.stringify({
            description: 'Project 1 loom',
            created_at: '2024-01-15T10:00:00.000Z',
            version: 1,
            branchName: 'issue-1__feat',
            worktreePath: '/Users/alice/project1',
            issueType: 'issue',
            issue_numbers: ['1'],
            pr_numbers: [],
            issueTracker: 'github',
            colorHex: '#ff0000',
            sessionId: '11111111-1111-1111-1111-111111111111',
            projectPath: '/Users/alice/main-project',
            issueUrls: { '1': 'https://github.com/org/repo/issues/1' },
            prUrls: {},
            capabilities: ['cli'],
          })
        }
        return JSON.stringify({
          description: 'Project 2 loom',
          created_at: '2024-01-16T10:00:00.000Z',
          version: 1,
          branchName: 'issue-2__fix',
          worktreePath: '/Users/bob/project2',
          issueType: 'issue',
          issue_numbers: ['2'],
          pr_numbers: [],
          issueTracker: 'github',
          colorHex: '#00ff00',
          sessionId: '22222222-2222-2222-2222-222222222222',
          projectPath: '/Users/bob/main-project',
          issueUrls: { '2': 'https://github.com/org/repo/issues/2' },
          prUrls: {},
          capabilities: ['web'],
        })
      })

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        description: 'Project 1 loom',
        created_at: '2024-01-15T10:00:00.000Z',
        branchName: 'issue-1__feat',
        worktreePath: '/Users/alice/project1',
        issueType: 'issue',
        issueKey: null,
        issue_numbers: ['1'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
        sessionId: '11111111-1111-1111-1111-111111111111',
        projectPath: '/Users/alice/main-project',
        issueUrls: { '1': 'https://github.com/org/repo/issues/1' },
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        complexity: null,
        capabilities: ['cli'],
        state: null,
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })
      expect(result[1]).toEqual({
        description: 'Project 2 loom',
        created_at: '2024-01-16T10:00:00.000Z',
        branchName: 'issue-2__fix',
        worktreePath: '/Users/bob/project2',
        issueType: 'issue',
        issueKey: null,
        issue_numbers: ['2'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#00ff00',
        sessionId: '22222222-2222-2222-2222-222222222222',
        projectPath: '/Users/bob/main-project',
        issueUrls: { '2': 'https://github.com/org/repo/issues/2' },
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        complexity: null,
        capabilities: ['web'],
        state: null,
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })
    })

    it('should skip non-JSON files', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        '___Users___alice___project1.json',
        'readme.txt',
        '.DS_Store',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Project 1 loom',
        version: 1,
        colorHex: '#ff0000',
      }))

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(1)
      expect(fs.readFile).toHaveBeenCalledTimes(1)
    })

    it('should skip files with invalid JSON', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'valid.json',
        'invalid.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const path = String(filePath)
        if (path.includes('invalid')) {
          return 'not valid json {'
        }
        return JSON.stringify({
          description: 'Valid loom',
          version: 1,
          colorHex: '#ff0000',
        })
      })

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(1)
      expect(result[0].description).toBe('Valid loom')
    })

    it('should skip files without description field', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'with-desc.json',
        'no-desc.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const path = String(filePath)
        if (path.includes('no-desc')) {
          return JSON.stringify({ version: 1, colorHex: '#ff0000' })
        }
        return JSON.stringify({
          description: 'Has description',
          version: 1,
          colorHex: '#00ff00',
        })
      })

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(1)
      expect(result[0].description).toBe('Has description')
    })

    it('should return null values for missing optional fields', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue(['minimal.json'] as unknown as string[])

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Minimal loom',
        version: 1,
      }))

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        description: 'Minimal loom',
        created_at: null,
        branchName: null,
        worktreePath: null,
        issueType: null,
        issueKey: null,
        issue_numbers: [],
        pr_numbers: [],
        issueTracker: null,
        colorHex: null,
        sessionId: null,
        projectPath: null,
        issueUrls: {},
        prUrls: {},
        draftPrNumber: null,
        oneShot: null,
        complexity: null,
        capabilities: [],
        state: null,
        childIssueNumbers: [],
        parentLoom: null,
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })
    })

    it('should include parentLoom in listed metadata', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue(['child-loom.json'] as unknown as string[])

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Child loom',
        created_at: '2024-01-15T10:00:00.000Z',
        version: 1,
        branchName: 'issue-200__child',
        worktreePath: '/Users/alice/child-project',
        issueType: 'issue',
        issue_numbers: ['200'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
        sessionId: '33333333-3333-3333-3333-333333333333',
        parentLoom: {
          type: 'issue',
          identifier: 100,
          branchName: 'issue-100__parent',
          worktreePath: '/Users/alice/parent-project',
          databaseBranch: 'db-branch-100',
        },
      }))

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(1)
      expect(result[0].parentLoom).toEqual({
        type: 'issue',
        identifier: 100,
        branchName: 'issue-100__parent',
        worktreePath: '/Users/alice/parent-project',
        databaseBranch: 'db-branch-100',
      })
    })

    it('should handle readdir error gracefully', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'))

      const result = await manager.listAllMetadata()

      expect(result).toEqual([])
    })

    it('should continue reading other files when one file read fails', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'good1.json',
        'bad.json',
        'good2.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const path = String(filePath)
        if (path.includes('bad')) {
          throw new Error('Permission denied')
        }
        if (path.includes('good1')) {
          return JSON.stringify({ description: 'Good 1', version: 1, colorHex: '#111111' })
        }
        return JSON.stringify({ description: 'Good 2', version: 1, colorHex: '#222222' })
      })

      const result = await manager.listAllMetadata()

      expect(result).toHaveLength(2)
      expect(result.map(r => r.description)).toEqual(['Good 1', 'Good 2'])
    })
  })

  describe('deleteMetadata', () => {
    const worktreePath = '/Users/jane/dev/repo'

    it('should delete file if exists', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      await manager.deleteMetadata(worktreePath)

      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(expectedLoomsDir, '___Users___jane___dev___repo.json')
      )
    })

    it('should not throw if file does not exist (idempotent)', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      await expect(manager.deleteMetadata(worktreePath)).resolves.not.toThrow()
      expect(fs.unlink).not.toHaveBeenCalled()
    })

    it('should log warning on permission error but not throw', async () => {
      const { logger } = await import('../utils/logger.js')
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'))

      await expect(manager.deleteMetadata(worktreePath)).resolves.not.toThrow()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Permission denied'))
    })
  })

  describe('archiveMetadata', () => {
    const worktreePath = '/Users/jane/dev/repo'
    const expectedFilename = '___Users___jane___dev___repo.json'
    const expectedFinishedDir = '/Users/testuser/.config/iloom-ai/looms/finished'

    it('should move metadata file to finished subdirectory with status fields', async () => {
      const mockDate = new Date('2024-01-20T15:30:00.000Z')
      vi.setSystemTime(mockDate)

      const originalContent = JSON.stringify({
        description: 'Original loom',
        created_at: '2024-01-15T10:00:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
      })

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(originalContent)
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      await manager.archiveMetadata(worktreePath)

      // Verify finished directory was created
      expect(fs.ensureDir).toHaveBeenCalledWith(expectedFinishedDir, { mode: 0o755 })

      // Verify file was written to finished directory with status fields
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(expectedFinishedDir, expectedFilename),
        expect.any(String),
        { mode: 0o644 }
      )

      // Verify the written content has status and finishedAt
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
      const writtenContent = JSON.parse(writeCall?.[1] as string)
      expect(writtenContent.status).toBe('finished')
      expect(writtenContent.finishedAt).toBe('2024-01-20T15:30:00.000Z')
      expect(writtenContent.description).toBe('Original loom')
      expect(writtenContent.branchName).toBe('issue-42__feature')

      // Verify original file was deleted
      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(expectedLoomsDir, expectedFilename)
      )

      vi.useRealTimers()
    })

    it('should not throw if source file does not exist (idempotent)', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      await expect(manager.archiveMetadata(worktreePath)).resolves.not.toThrow()
      expect(fs.readFile).not.toHaveBeenCalled()
      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    it('should log warning on error but not throw', async () => {
      const { logger } = await import('../utils/logger.js')
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Read error'))

      await expect(manager.archiveMetadata(worktreePath)).resolves.not.toThrow()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Read error'))
    })
  })

  describe('listFinishedMetadata', () => {
    it('should return empty array when finished directory does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      const result = await manager.listFinishedMetadata()

      expect(result).toEqual([])
      expect(fs.readdir).not.toHaveBeenCalled()
    })

    it('should return finished looms sorted by finishedAt descending', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'loom1.json',
        'loom2.json',
        'loom3.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const pathStr = String(filePath)
        if (pathStr.includes('loom1')) {
          return JSON.stringify({
            description: 'First finished',
            status: 'finished',
            finishedAt: '2024-01-15T10:00:00.000Z', // Earliest
            branchName: 'issue-1__feat',
          })
        }
        if (pathStr.includes('loom2')) {
          return JSON.stringify({
            description: 'Second finished',
            status: 'finished',
            finishedAt: '2024-01-20T10:00:00.000Z', // Latest
            branchName: 'issue-2__fix',
          })
        }
        return JSON.stringify({
          description: 'Third finished',
          status: 'finished',
          finishedAt: '2024-01-18T10:00:00.000Z', // Middle
          branchName: 'issue-3__docs',
        })
      })

      const result = await manager.listFinishedMetadata()

      expect(result).toHaveLength(3)
      // Should be sorted by finishedAt descending (latest first)
      expect(result[0].description).toBe('Second finished')
      expect(result[1].description).toBe('Third finished')
      expect(result[2].description).toBe('First finished')
    })

    it('should return metadata with status and finishedAt fields', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue(['finished-loom.json'] as unknown as string[])

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Finished loom',
        created_at: '2024-01-15T10:00:00.000Z',
        version: 1,
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
        status: 'finished',
        finishedAt: '2024-01-20T15:00:00.000Z',
      }))

      const result = await manager.listFinishedMetadata()

      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('finished')
      expect(result[0].finishedAt).toBe('2024-01-20T15:00:00.000Z')
      expect(result[0].branchName).toBe('issue-42__feature')
    })

    it('should skip files without description field', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'valid.json',
        'no-desc.json',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
        const pathStr = String(filePath)
        if (pathStr.includes('no-desc')) {
          return JSON.stringify({ status: 'finished', finishedAt: '2024-01-20T10:00:00.000Z' })
        }
        return JSON.stringify({
          description: 'Valid finished loom',
          status: 'finished',
          finishedAt: '2024-01-20T10:00:00.000Z',
        })
      })

      const result = await manager.listFinishedMetadata()

      expect(result).toHaveLength(1)
      expect(result[0].description).toBe('Valid finished loom')
    })

    it('should skip non-JSON files', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockResolvedValue([
        'loom.json',
        'readme.txt',
        '.DS_Store',
      ] as unknown as string[])

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Finished loom',
        status: 'finished',
        finishedAt: '2024-01-20T10:00:00.000Z',
      }))

      const result = await manager.listFinishedMetadata()

      expect(result).toHaveLength(1)
      expect(fs.readFile).toHaveBeenCalledTimes(1)
    })

    it('should handle readdir error gracefully', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'))

      const result = await manager.listFinishedMetadata()

      expect(result).toEqual([])
    })
  })

  describe('updateMetadata', () => {
    const worktreePath = '/Users/jane/dev/repo'

    it('should merge updates into existing metadata', async () => {
      const existingContent = JSON.stringify({
        description: 'Epic loom',
        created_at: '2024-01-15T10:30:00.000Z',
        version: 1,
        branchName: 'issue-100__epic',
        issueType: 'issue',
        issue_numbers: ['100'],
      })

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(existingContent)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const childIssues = [
        { number: '#101', title: 'Task 1', body: 'Body 1', url: 'url1' },
        { number: '#102', title: 'Task 2', body: 'Body 2', url: 'url2' },
      ]
      const dependencyMap = { '101': [], '102': ['101'] }

      await manager.updateMetadata(worktreePath, { childIssues, dependencyMap })

      expect(fs.writeFile).toHaveBeenCalledTimes(1)
      const writtenContent = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)
      expect(writtenContent.description).toBe('Epic loom')
      expect(writtenContent.childIssues).toEqual(childIssues)
      expect(writtenContent.dependencyMap).toEqual(dependencyMap)
      expect(writtenContent.branchName).toBe('issue-100__epic')
    })

    it('should not throw when metadata file does not exist', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false)

      await expect(
        manager.updateMetadata(worktreePath, { childIssues: [] })
      ).resolves.not.toThrow()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    it('should re-throw on write error', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ description: 'test', version: 1 }))
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write error'))

      await expect(
        manager.updateMetadata(worktreePath, { childIssues: [] })
      ).rejects.toThrow('Write error')
    })
  })

  describe('childIssues and dependencyMap fields', () => {
    const worktreePath = '/Users/jane/dev/repo'

    it('should read childIssues and dependencyMap from metadata', async () => {
      const childIssues = [
        { number: '#101', title: 'Task 1', body: 'Body 1', url: 'url1' },
      ]
      const dependencyMap = { '101': [] }

      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Epic loom',
        version: 1,
        childIssues,
        dependencyMap,
      }))

      const result = await manager.readMetadata(worktreePath)

      expect(result?.childIssues).toEqual(childIssues)
      expect(result?.dependencyMap).toEqual(dependencyMap)
    })

    it('should return empty defaults for legacy looms without child data', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true)
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
        description: 'Legacy loom',
        version: 1,
      }))

      const result = await manager.readMetadata(worktreePath)

      expect(result?.childIssues).toEqual([])
      expect(result?.dependencyMap).toEqual({})
    })

    it('should write childIssues and dependencyMap when provided', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const childIssues = [
        { number: '#101', title: 'Task 1', body: 'Body 1', url: 'url1' },
      ]

      await manager.writeMetadata(worktreePath, {
        description: 'Epic loom',
        branchName: 'issue-100__epic',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['100'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
        sessionId: 'test-session',
        projectPath: '/Users/jane/dev',
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        childIssues,
        dependencyMap: { '101': [] },
      })

      const writtenContent = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)
      expect(writtenContent.childIssues).toEqual(childIssues)
      expect(writtenContent.dependencyMap).toEqual({ '101': [] })
    })

    it('should not write childIssues when empty', async () => {
      vi.mocked(fs.ensureDir).mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      await manager.writeMetadata(worktreePath, {
        description: 'Regular loom',
        branchName: 'issue-42__feature',
        worktreePath: '/Users/jane/dev/repo',
        issueType: 'issue',
        issue_numbers: ['42'],
        pr_numbers: [],
        issueTracker: 'github',
        colorHex: '#ff0000',
        sessionId: 'test-session',
        projectPath: '/Users/jane/dev',
        issueUrls: {},
        prUrls: {},
        capabilities: [],
        childIssues: [],
        dependencyMap: {},
        mcpConfigPath: null,
      })

      const writtenContent = JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)
      expect(writtenContent.childIssues).toBeUndefined()
      expect(writtenContent.dependencyMap).toBeUndefined()
    })
  })
})
