import { beforeEach, vi } from 'vitest'

// Global test setup
beforeEach(() => {
  // Reset all mocks before each test
  vi.clearAllMocks()
  vi.resetAllMocks()
  vi.restoreAllMocks()

  // Reset environment variables to clean state
  delete process.env.GITHUB_TOKEN
  delete process.env.CLAUDE_API_KEY
  delete process.env.NEON_API_KEY
})
