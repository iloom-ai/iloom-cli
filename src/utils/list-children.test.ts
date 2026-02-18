import { describe, it, expect, vi } from 'vitest'
import {
  fetchChildIssues,
  findChildLooms,
  matchChildrenData,
  assembleChildrenData,
  fetchChildIssueDetails,
} from './list-children.js'
import type { IssueTracker } from '../lib/IssueTracker.js'
import type { LoomMetadata, MetadataManager } from '../lib/MetadataManager.js'

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}))

// Helper factories

/**
 * Create a mock IssueTracker with getChildIssues method
 */
function createMockIssueTracker(overrides: Partial<IssueTracker> = {}): IssueTracker {
  return {
    providerName: 'github',
    supportsPullRequests: true,
    detectInputType: vi.fn(),
    fetchIssue: vi.fn(),
    isValidIssue: vi.fn(),
    validateIssueState: vi.fn(),
    createIssue: vi.fn(),
    getIssueUrl: vi.fn(),
    getChildIssues: vi.fn().mockResolvedValue([]),
    normalizeIdentifier: vi.fn((id) => String(id)),
    extractContext: vi.fn(),
    ...overrides,
  }
}

/**
 * Create a minimal LoomMetadata object for testing
 */
function createLoomMetadata(overrides: Partial<LoomMetadata> = {}): LoomMetadata {
  return {
    description: 'Test loom',
    created_at: '2024-01-15T10:00:00.000Z',
    branchName: 'issue-100__parent-feature',
    worktreePath: '/Users/dev/projects/myapp-looms/issue-100__parent-feature',
    issueType: 'issue',
    issue_numbers: ['100'],
    pr_numbers: [],
    issueTracker: 'github',
    colorHex: '#dcebff',
    sessionId: 'session-123',
    projectPath: '/Users/dev/projects/myapp',
    issueUrls: { '100': 'https://github.com/owner/repo/issues/100' },
    prUrls: {},
    draftPrNumber: null,
    capabilities: [],
    parentLoom: null,
    ...overrides,
  }
}

/**
 * Create a child loom metadata object (has parentLoom set)
 */
function createChildLoomMetadata(
  parentBranchName: string,
  issueNumber: string,
  overrides: Partial<LoomMetadata> = {},
): LoomMetadata {
  return createLoomMetadata({
    branchName: `issue-${issueNumber}__child-feature`,
    worktreePath: `/Users/dev/projects/myapp-looms/issue-${issueNumber}__child-feature`,
    issue_numbers: [issueNumber],
    issueUrls: { [issueNumber]: `https://github.com/owner/repo/issues/${issueNumber}` },
    parentLoom: {
      type: 'issue',
      identifier: '100',
      branchName: parentBranchName,
      worktreePath: `/Users/dev/projects/myapp-looms/${parentBranchName}`,
    },
    ...overrides,
  })
}

/**
 * Mock MetadataManager type for testing
 */
interface MockMetadataManager {
  listAllMetadata: ReturnType<typeof vi.fn<() => Promise<LoomMetadata[]>>>
  readMetadata: ReturnType<typeof vi.fn>
  writeMetadata: ReturnType<typeof vi.fn>
  deleteMetadata: ReturnType<typeof vi.fn>
  archiveMetadata: ReturnType<typeof vi.fn>
  listFinishedMetadata: ReturnType<typeof vi.fn<() => Promise<LoomMetadata[]>>>
}

/**
 * Create a mock MetadataManager
 */
function createMockMetadataManager(metadata: LoomMetadata[] = []): MockMetadataManager {
  return {
    listAllMetadata: vi.fn<() => Promise<LoomMetadata[]>>().mockResolvedValue(metadata),
    readMetadata: vi.fn(),
    writeMetadata: vi.fn(),
    deleteMetadata: vi.fn(),
    archiveMetadata: vi.fn(),
    listFinishedMetadata: vi.fn<() => Promise<LoomMetadata[]>>().mockResolvedValue([]),
  }
}

describe('list-children', () => {
  describe('fetchChildIssues', () => {
    it('should delegate to issueTracker.getChildIssues()', async () => {
      const mockChildIssues = [
        { id: '101', title: 'Sub-task 1', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
        { id: '102', title: 'Sub-task 2', url: 'https://github.com/owner/repo/issues/102', state: 'closed' },
      ]
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue(mockChildIssues),
      })

      const result = await fetchChildIssues('100', mockTracker)

      expect(mockTracker.getChildIssues).toHaveBeenCalledWith('100', undefined)
      expect(result).toEqual(mockChildIssues)
    })

    it('should pass repo parameter to issueTracker.getChildIssues()', async () => {
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue([]),
      })

      await fetchChildIssues('100', mockTracker, 'owner/repo')

      expect(mockTracker.getChildIssues).toHaveBeenCalledWith('100', 'owner/repo')
    })

    it('should return empty array when API fails (fault tolerance)', async () => {
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockRejectedValue(new Error('API Error')),
      })

      const result = await fetchChildIssues('100', mockTracker)

      expect(result).toEqual([])
    })
  })

  describe('findChildLooms', () => {
    it('should find looms where parentLoom.branchName matches parent branch', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const childLoom1 = createChildLoomMetadata(parentBranchName, '101')
      const childLoom2 = createChildLoomMetadata(parentBranchName, '102')
      const unrelatedLoom = createLoomMetadata({
        branchName: 'issue-200__other-feature',
        issue_numbers: ['200'],
      })

      const mockManager = createMockMetadataManager([childLoom1, childLoom2, unrelatedLoom])

      const result = await findChildLooms(parentBranchName, mockManager as unknown as MetadataManager)

      expect(result).toHaveLength(2)
      expect(result).toContainEqual(childLoom1)
      expect(result).toContainEqual(childLoom2)
      expect(result).not.toContainEqual(unrelatedLoom)
    })

    it('should return empty array when no child looms exist', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const unrelatedLoom = createLoomMetadata({
        branchName: 'issue-200__other-feature',
        issue_numbers: ['200'],
      })

      const mockManager = createMockMetadataManager([unrelatedLoom])

      const result = await findChildLooms(parentBranchName, mockManager as unknown as MetadataManager)

      expect(result).toEqual([])
    })

    it('should not include looms without parentLoom field', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const loomWithoutParent = createLoomMetadata({
        branchName: 'issue-101__no-parent',
        issue_numbers: ['101'],
        parentLoom: null,
      })

      const mockManager = createMockMetadataManager([loomWithoutParent])

      const result = await findChildLooms(parentBranchName, mockManager as unknown as MetadataManager)

      expect(result).toEqual([])
    })

    it('should handle empty metadata list', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const mockManager = createMockMetadataManager([])

      const result = await findChildLooms(parentBranchName, mockManager as unknown as MetadataManager)

      expect(result).toEqual([])
    })

    it('should match only by exact branchName (no partial matches)', async () => {
      const parentBranchName = 'issue-100__feature'
      // This loom has a similar but not exact parent branch name
      const similarParentLoom = createChildLoomMetadata('issue-100__feature-extended', '101')

      const mockManager = createMockMetadataManager([similarParentLoom])

      const result = await findChildLooms(parentBranchName, mockManager as unknown as MetadataManager)

      expect(result).toEqual([])
    })
  })

  describe('matchChildrenData', () => {
    it('should match child issues to child looms by issue number', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task 1', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
        { id: '102', title: 'Sub-task 2', url: 'https://github.com/owner/repo/issues/102', state: 'closed' },
      ]
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101'),
      ]

      const result = matchChildrenData(childIssues, childLooms)

      // Issue 101 has a matching loom
      expect(result.issues[0]).toEqual({
        id: '101',
        title: 'Sub-task 1',
        url: 'https://github.com/owner/repo/issues/101',
        state: 'open',
        hasActiveLoom: true,
        loomBranch: 'issue-101__child-feature',
      })

      // Issue 102 has no matching loom
      expect(result.issues[1]).toEqual({
        id: '102',
        title: 'Sub-task 2',
        url: 'https://github.com/owner/repo/issues/102',
        state: 'closed',
        hasActiveLoom: false,
        loomBranch: null,
      })
    })

    it('should mark issues with hasActiveLoom: true when loom exists', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
      ]
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101'),
      ]

      const result = matchChildrenData(childIssues, childLooms)

      expect(result.issues[0].hasActiveLoom).toBe(true)
      expect(result.issues[0].loomBranch).toBe('issue-101__child-feature')
    })

    it('should mark looms with hasMatchingIssue: false when orphaned', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
      ]
      // This loom is for issue 103, which is not in the child issues list
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '103'),
      ]

      const result = matchChildrenData(childIssues, childLooms)

      expect(result.looms[0].hasMatchingIssue).toBe(false)
    })

    it('should mark looms with hasMatchingIssue: true when matching issue exists', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
      ]
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101'),
      ]

      const result = matchChildrenData(childIssues, childLooms)

      expect(result.looms[0].hasMatchingIssue).toBe(true)
    })

    it('should compute correct summary statistics', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task 1', url: 'url1', state: 'open' },
        { id: '102', title: 'Sub-task 2', url: 'url2', state: 'closed' },
        { id: '103', title: 'Sub-task 3', url: 'url3', state: 'open' },
      ]
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101'), // Matches issue 101
        createChildLoomMetadata('issue-100__parent', '104'), // Orphan (no matching issue)
      ]

      const result = matchChildrenData(childIssues, childLooms)

      expect(result.summary).toEqual({
        totalIssues: 3,
        issuesWithLooms: 1, // Only issue 101 has a loom
        totalLooms: 2,
        orphanLooms: 1, // Loom for issue 104 is orphan
      })
    })

    it('should handle empty child issues array', () => {
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101'),
      ]

      const result = matchChildrenData([], childLooms)

      expect(result.issues).toEqual([])
      expect(result.looms[0].hasMatchingIssue).toBe(false)
      expect(result.summary.totalIssues).toBe(0)
      expect(result.summary.orphanLooms).toBe(1)
    })

    it('should handle empty child looms array', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task', url: 'url', state: 'open' },
      ]

      const result = matchChildrenData(childIssues, [])

      expect(result.looms).toEqual([])
      expect(result.issues[0].hasActiveLoom).toBe(false)
      expect(result.summary.totalLooms).toBe(0)
      expect(result.summary.orphanLooms).toBe(0)
    })

    it('should handle both arrays empty', () => {
      const result = matchChildrenData([], [])

      expect(result.issues).toEqual([])
      expect(result.looms).toEqual([])
      expect(result.summary).toEqual({
        totalIssues: 0,
        issuesWithLooms: 0,
        totalLooms: 0,
        orphanLooms: 0,
      })
    })

    it('should handle looms with multiple issue_numbers', () => {
      const childIssues = [
        { id: '101', title: 'Sub-task 1', url: 'url1', state: 'open' },
        { id: '102', title: 'Sub-task 2', url: 'url2', state: 'open' },
      ]
      // Loom tracks both issues 101 and 102
      const childLooms = [
        createChildLoomMetadata('issue-100__parent', '101', {
          issue_numbers: ['101', '102'],
        }),
      ]

      const result = matchChildrenData(childIssues, childLooms)

      // Both issues should find the same loom
      expect(result.issues[0].hasActiveLoom).toBe(true)
      expect(result.issues[1].hasActiveLoom).toBe(true)
      // The loom has matching issues
      expect(result.looms[0].hasMatchingIssue).toBe(true)
      expect(result.summary.issuesWithLooms).toBe(2)
    })
  })

  describe('assembleChildrenData', () => {
    it('should return null when parent loom has no issue_numbers', async () => {
      const parentLoom = createLoomMetadata({
        issue_numbers: [],
      })
      const mockManager = createMockMetadataManager()
      const mockTracker = createMockIssueTracker()

      const result = await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      expect(result).toBeNull()
    })

    it('should return null when parent loom issue_numbers is undefined', async () => {
      const parentLoom = createLoomMetadata()
      // @ts-expect-error - Testing edge case
      parentLoom.issue_numbers = undefined
      const mockManager = createMockMetadataManager()
      const mockTracker = createMockIssueTracker()

      const result = await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      expect(result).toBeNull()
    })

    it('should return null when parent loom has no branchName', async () => {
      const parentLoom = createLoomMetadata({
        branchName: null,
        issue_numbers: ['100'],
      })
      const mockManager = createMockMetadataManager()
      const mockTracker = createMockIssueTracker()

      const result = await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      expect(result).toBeNull()
    })

    it('should return ChildrenData object with issues and looms', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const parentLoom = createLoomMetadata({
        branchName: parentBranchName,
        issue_numbers: ['100'],
      })

      const mockChildIssues = [
        { id: '101', title: 'Sub-task 1', url: 'https://github.com/owner/repo/issues/101', state: 'open' },
      ]

      const childLoom = createChildLoomMetadata(parentBranchName, '101')
      const mockManager = createMockMetadataManager([childLoom])
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue(mockChildIssues),
      })

      const result = await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      expect(result).not.toBeNull()
      expect(result!.issues).toHaveLength(1)
      expect(result!.issues[0].id).toBe('101')
      expect(result!.issues[0].hasActiveLoom).toBe(true)
      expect(result!.looms).toHaveLength(1)
      expect(result!.looms[0].hasMatchingIssue).toBe(true)
    })

    it('should handle API failure gracefully and return empty issues', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const parentLoom = createLoomMetadata({
        branchName: parentBranchName,
        issue_numbers: ['100'],
      })

      const childLoom = createChildLoomMetadata(parentBranchName, '101')
      const mockManager = createMockMetadataManager([childLoom])
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockRejectedValue(new Error('API Error')),
      })

      const result = await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      // Should return data even if API fails - just with empty issues
      expect(result).not.toBeNull()
      expect(result!.issues).toEqual([])
      expect(result!.looms).toHaveLength(1)
      expect(result!.looms[0].hasMatchingIssue).toBe(false) // No issues to match
    })

    it('should use first issue number when multiple exist', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const parentLoom = createLoomMetadata({
        branchName: parentBranchName,
        issue_numbers: ['100', '99'], // Multiple issue numbers
      })

      const mockManager = createMockMetadataManager([])
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue([]),
      })

      await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      // Should use first issue number (100)
      expect(mockTracker.getChildIssues).toHaveBeenCalledWith('100', undefined)
    })

    it('should pass repo parameter when provided', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const parentLoom = createLoomMetadata({
        branchName: parentBranchName,
        issue_numbers: ['100'],
      })

      const mockManager = createMockMetadataManager([])
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue([]),
      })

      await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker, 'owner/repo')

      expect(mockTracker.getChildIssues).toHaveBeenCalledWith('100', 'owner/repo')
    })

    it('should fetch child issues and child looms in parallel', async () => {
      const parentBranchName = 'issue-100__parent-feature'
      const parentLoom = createLoomMetadata({
        branchName: parentBranchName,
        issue_numbers: ['100'],
      })

      // Track call order
      const callOrder: string[] = []

      const mockManager = createMockMetadataManager([])
      vi.mocked(mockManager.listAllMetadata).mockImplementation(async () => {
        callOrder.push('listAllMetadata-start')
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10))
        callOrder.push('listAllMetadata-end')
        return []
      })

      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockImplementation(async () => {
          callOrder.push('getChildIssues-start')
          await new Promise((resolve) => globalThis.setTimeout(resolve, 10))
          callOrder.push('getChildIssues-end')
          return []
        }),
      })

      await assembleChildrenData(parentLoom, mockManager as unknown as MetadataManager, mockTracker)

      // Both should start before either finishes (parallel execution)
      const childIssuesStartIndex = callOrder.indexOf('getChildIssues-start')
      const metadataStartIndex = callOrder.indexOf('listAllMetadata-start')
      const childIssuesEndIndex = callOrder.indexOf('getChildIssues-end')
      const metadataEndIndex = callOrder.indexOf('listAllMetadata-end')

      // Both starts should happen before any end (they run in parallel)
      expect(childIssuesStartIndex).toBeLessThan(Math.max(childIssuesEndIndex, metadataEndIndex))
      expect(metadataStartIndex).toBeLessThan(Math.max(childIssuesEndIndex, metadataEndIndex))
    })
  })

  describe('fetchChildIssueDetails', () => {
    it('should fetch child issues with details and proper GitHub prefixes', async () => {
      const mockTracker = createMockIssueTracker({
        providerName: 'github',
        getChildIssues: vi.fn().mockResolvedValue([
          { id: '101', title: 'Task 1', url: 'https://github.com/o/r/issues/101', state: 'open' },
          { id: '102', title: 'Task 2', url: 'https://github.com/o/r/issues/102', state: 'open' },
        ]),
        fetchIssue: vi.fn()
          .mockResolvedValueOnce({ number: 101, title: 'Task 1', body: 'Body 1', state: 'open', labels: [], assignees: [], url: 'url1' })
          .mockResolvedValueOnce({ number: 102, title: 'Task 2', body: 'Body 2', state: 'open', labels: [], assignees: [], url: 'url2' }),
      })

      const result = await fetchChildIssueDetails('100', mockTracker)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        number: '#101',
        title: 'Task 1',
        body: 'Body 1',
        url: 'https://github.com/o/r/issues/101',
      })
      expect(result[1]).toEqual({
        number: '#102',
        title: 'Task 2',
        body: 'Body 2',
        url: 'https://github.com/o/r/issues/102',
      })
    })

    it('should use Linear prefix format for Linear issues', async () => {
      const mockTracker = createMockIssueTracker({
        providerName: 'linear',
        getChildIssues: vi.fn().mockResolvedValue([
          { id: 'ENG-101', title: 'Linear Task', url: 'https://linear.app/issue/ENG-101', state: 'In Progress' },
        ]),
        fetchIssue: vi.fn().mockResolvedValue({
          number: 'ENG-101', title: 'Linear Task', body: 'Linear body', state: 'open', labels: [], assignees: [], url: 'url',
        }),
      })

      const result = await fetchChildIssueDetails('ENG-100', mockTracker)

      expect(result).toHaveLength(1)
      expect(result[0].number).toBe('ENG-101') // No prefix added for Linear
    })

    it('should fall back to child list data when full fetch fails', async () => {
      const mockTracker = createMockIssueTracker({
        providerName: 'github',
        getChildIssues: vi.fn().mockResolvedValue([
          { id: '101', title: 'Task 1', url: 'https://github.com/o/r/issues/101', state: 'open' },
        ]),
        fetchIssue: vi.fn().mockRejectedValue(new Error('API Error')),
      })

      const result = await fetchChildIssueDetails('100', mockTracker)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        number: '#101',
        title: 'Task 1',
        body: '', // Empty body when fetch fails
        url: 'https://github.com/o/r/issues/101',
      })
    })

    it('should return empty array when no child issues exist', async () => {
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue([]),
      })

      const result = await fetchChildIssueDetails('100', mockTracker)

      expect(result).toEqual([])
    })

    it('should pass repo parameter when provided', async () => {
      const mockTracker = createMockIssueTracker({
        getChildIssues: vi.fn().mockResolvedValue([]),
      })

      await fetchChildIssueDetails('100', mockTracker, 'owner/repo')

      expect(mockTracker.getChildIssues).toHaveBeenCalledWith('100', 'owner/repo')
    })
  })
})
