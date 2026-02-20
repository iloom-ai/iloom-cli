import { describe, it, expect, vi } from 'vitest'
import { buildDependencyMap } from './dependency-map.js'
import type { IloomSettings } from '../lib/SettingsManager.js'

// Mock the provider-specific dependency fetchers
vi.mock('./github.js', () => ({
  getIssueDependencies: vi.fn(),
}))

vi.mock('./linear.js', () => ({
  getLinearIssueDependencies: vi.fn(),
}))

// Mock logger
vi.mock('./logger-context.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('buildDependencyMap', () => {
  const githubSettings: IloomSettings = {
    issueManagement: { provider: 'github' },
  } as IloomSettings

  const linearSettings: IloomSettings = {
    issueManagement: { provider: 'linear' },
  } as IloomSettings

  it('should return empty dependency arrays for children with no dependencies (GitHub)', async () => {
    const { getIssueDependencies } = await import('./github.js')
    const mockGetDeps = vi.mocked(getIssueDependencies)
    mockGetDeps.mockResolvedValue([])

    const result = await buildDependencyMap(['101', '102', '103'], githubSettings)

    expect(result).toEqual({
      '#101': [],
      '#102': [],
      '#103': [],
    })
  })

  it('should include only sibling dependencies (GitHub)', async () => {
    const { getIssueDependencies } = await import('./github.js')
    const mockGetDeps = vi.mocked(getIssueDependencies)

    // Issue 102 is blocked by 101 (sibling) and 999 (external)
    mockGetDeps.mockImplementation(async (issueNumber) => {
      if (issueNumber === 102) {
        return [
          { id: '101', databaseId: 1, title: 'Task 1', url: 'url1', state: 'open' },
          { id: '999', databaseId: 9, title: 'External', url: 'url9', state: 'open' },
        ]
      }
      return []
    })

    const result = await buildDependencyMap(['101', '102', '103'], githubSettings)

    expect(result['#102']).toEqual(['#101'])
    // External dependency (999) should be filtered out
    expect(result['#101']).toEqual([])
    expect(result['#103']).toEqual([])
  })

  it('should handle Linear provider dependencies', async () => {
    const { getLinearIssueDependencies } = await import('./linear.js')
    const mockGetDeps = vi.mocked(getLinearIssueDependencies)

    mockGetDeps.mockImplementation(async (identifier) => {
      if (identifier === 'ENG-102') {
        return {
          blocking: [],
          blockedBy: [
            { id: 'ENG-101', title: 'Task 1', url: 'url1', state: 'In Progress' },
          ],
        }
      }
      return { blocking: [], blockedBy: [] }
    })

    const result = await buildDependencyMap(
      ['ENG-101', 'ENG-102', 'ENG-103'],
      linearSettings,
    )

    expect(result['ENG-102']).toEqual(['ENG-101'])
    expect(result['ENG-101']).toEqual([])
  })

  it('should handle API failures gracefully', async () => {
    const { getIssueDependencies } = await import('./github.js')
    const mockGetDeps = vi.mocked(getIssueDependencies)

    // First call succeeds, second throws
    mockGetDeps
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce([])

    const result = await buildDependencyMap(['101', '102', '103'], githubSettings)

    // Should still have entries for all children (failed ones get empty array)
    expect(result['#101']).toEqual([])
    expect(result['#102']).toEqual([])
    expect(result['#103']).toEqual([])
  })

  it('should return empty arrays for unsupported providers', async () => {
    const jiraSettings: IloomSettings = {
      issueManagement: { provider: 'jira' },
    } as IloomSettings

    const result = await buildDependencyMap(['PROJ-1', 'PROJ-2'], jiraSettings)

    expect(result).toEqual({
      'PROJ-1': [],
      'PROJ-2': [],
    })
  })

  it('should handle empty child issue list', async () => {
    const result = await buildDependencyMap([], githubSettings)

    expect(result).toEqual({})
  })
})
