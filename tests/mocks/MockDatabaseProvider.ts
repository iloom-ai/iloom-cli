import { vi } from 'vitest'
import type { DatabaseProvider } from '../../src/types/index.js'
import type { DatabaseManager } from '../../src/lib/DatabaseManager.js'

/**
 * Creates a mock DatabaseProvider with reasonable defaults for testing.
 * Individual methods can be overridden via the overrides parameter.
 */
export function createMockDatabaseProvider(
  overrides?: Partial<DatabaseProvider>
): DatabaseProvider {
  return {
    displayName: 'MockDB',
    installHint: 'npm install -g mockdb-cli',
    isCliAvailable: vi.fn().mockResolvedValue(true),
    isAuthenticated: vi.fn().mockResolvedValue(true),
    isConfigured: vi.fn().mockReturnValue(true),
    createBranch: vi.fn().mockResolvedValue('postgresql://test-connection-string'),
    deleteBranch: vi.fn().mockResolvedValue({
      success: true,
      deleted: true,
      notFound: false,
      branchName: 'test-branch'
    }),
    sanitizeBranchName: vi.fn((name: string) => name.replace(/\//g, '_')),
    branchExists: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue([]),
    getConnectionString: vi.fn().mockResolvedValue('postgresql://test-connection'),
    ...overrides,
  }
}

/**
 * Creates a mock DatabaseManager with reasonable defaults for testing.
 * Individual methods can be overridden via the overrides parameter.
 */
export function createMockDatabaseManager(
  overrides?: Partial<DatabaseManager>
): DatabaseManager {
  const mockManager = {
    createBranchIfConfigured: vi
      .fn()
      .mockResolvedValue('postgresql://test-connection-string'),
    deleteBranchIfConfigured: vi.fn().mockResolvedValue({
      success: true,
      deleted: true,
      notFound: false,
      branchName: 'test-branch'
    }),
    shouldUseDatabaseBranching: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as DatabaseManager

  return mockManager
}
