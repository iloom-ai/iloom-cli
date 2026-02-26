import { describe, it, expect, vi } from 'vitest'
import { execa } from 'execa'
import { computeReviewDiffCommand } from '../../src/utils/git.js'

vi.mock('execa')

/**
 * Helper to create a successful execa result with given stdout
 */
function mockResult(stdout: string) {
  return { stdout } as unknown as Awaited<ReturnType<typeof execa>>
}

/**
 * Helper to create a GitCommandError-like execa error (simulates git command failure).
 * The error must have .stderr so that the GitCommandError constructor captures it,
 * and the catch blocks in computeReviewDiffCommand can inspect error.stderr.
 */
function mockError(stderr: string, exitCode = 1): Error {
  const error = new Error(`Git command failed: ${stderr}`) as Error & {
    stderr: string
    exitCode: number
  }
  error.stderr = stderr
  error.exitCode = exitCode
  return error
}

describe('computeReviewDiffCommand', () => {
  const defaultProtectedBranches = ['main', 'master', 'develop']

  describe('on a protected branch (main/master/develop)', () => {
    it('returns git diff for uncommitted changes when on main', async () => {
      // getCurrentBranch calls: git branch --show-current
      vi.mocked(execa).mockResolvedValueOnce(mockResult('main'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })

    it('returns git diff for uncommitted changes when on develop', async () => {
      vi.mocked(execa).mockResolvedValueOnce(mockResult('develop'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })

    it('respects custom protected branches list', async () => {
      vi.mocked(execa).mockResolvedValueOnce(mockResult('staging'))

      const result = await computeReviewDiffCommand('/repo', ['main', 'staging'])

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })
  })

  describe('on feature branch with remote tracking branch', () => {
    it('returns git diff against pre-computed merge-base with upstream', async () => {
      // getCurrentBranch -> 'feature/my-branch'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/my-branch'))
      // rev-parse --abbrev-ref @{upstream} -> 'origin/feature/my-branch'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('origin/feature/my-branch'))
      // merge-base HEAD origin/feature/my-branch -> SHA hash
      vi.mocked(execa).mockResolvedValueOnce(mockResult('abc123def456'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({
        cmd: 'git diff abc123def456',
        description: 'changes not yet on remote',
      })
    })
  })

  describe('on feature branch without remote tracking branch', () => {
    it('returns git diff against pre-computed merge-base with default branch', async () => {
      // getCurrentBranch -> 'feature/my-branch'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/my-branch'))
      // rev-parse --abbrev-ref @{upstream} -> throws (no upstream)
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: no upstream configured for branch', 128)
      )
      // getDefaultBranch calls: git symbolic-ref refs/remotes/origin/HEAD
      vi.mocked(execa).mockResolvedValueOnce(mockResult('refs/remotes/origin/main'))
      // merge-base HEAD main -> SHA hash
      vi.mocked(execa).mockResolvedValueOnce(mockResult('deadbeef1234'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({
        cmd: 'git diff deadbeef1234',
        description: 'changes since diverging from main',
      })
    })

    it('uses detected default branch name (e.g., master)', async () => {
      // getCurrentBranch -> 'fix/bug-123'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('fix/bug-123'))
      // rev-parse --abbrev-ref @{upstream} -> throws
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: no upstream configured for branch', 128)
      )
      // getDefaultBranch: git symbolic-ref refs/remotes/origin/HEAD -> returns master
      vi.mocked(execa).mockResolvedValueOnce(mockResult('refs/remotes/origin/master'))
      // merge-base HEAD master -> SHA hash
      vi.mocked(execa).mockResolvedValueOnce(mockResult('cafebabe5678'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({
        cmd: 'git diff cafebabe5678',
        description: 'changes since diverging from master',
      })
    })
  })

  describe('detached HEAD', () => {
    it('falls back to git diff for uncommitted changes', async () => {
      // getCurrentBranch returns empty string for detached HEAD (git branch --show-current)
      vi.mocked(execa).mockResolvedValueOnce(mockResult(''))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })
  })

  describe('edge: getCurrentBranch throws', () => {
    it('falls back to git diff for uncommitted changes', async () => {
      // getCurrentBranch throws (e.g., not a git repo)
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: not a git repository', 128)
      )

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })
  })

  describe('default protected branches when none specified', () => {
    it('does not treat any branch as protected when protectedBranches is empty', async () => {
      // 'main' is not protected when protectedBranches is empty
      vi.mocked(execa).mockResolvedValueOnce(mockResult('main'))
      // Since 'main' is not protected, it proceeds to check upstream
      vi.mocked(execa).mockResolvedValueOnce(mockResult('origin/main'))
      // merge-base HEAD origin/main -> SHA hash
      vi.mocked(execa).mockResolvedValueOnce(mockResult('ff00ff00'))

      const result = await computeReviewDiffCommand('/repo', [])

      expect(result).toEqual({
        cmd: 'git diff ff00ff00',
        description: 'changes not yet on remote',
      })
    })
  })

  describe('edge: default branch detection fails', () => {
    it('uses main as fallback when symbolic-ref fails and pre-computes merge-base', async () => {
      // getCurrentBranch -> 'feature/x'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/x'))
      // rev-parse --abbrev-ref @{upstream} -> throws (no upstream)
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: no upstream configured for branch', 128)
      )
      // getDefaultBranch: symbolic-ref fails -> catch returns 'main'
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref', 128)
      )
      // merge-base HEAD main (getDefaultBranch returned 'main' from its catch)
      vi.mocked(execa).mockResolvedValueOnce(mockResult('aabbccdd'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({
        cmd: 'git diff aabbccdd',
        description: 'changes since diverging from main',
      })
    })

    it('falls back to git diff when merge-base computation fails', async () => {
      // getCurrentBranch -> 'feature/y'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/y'))
      // rev-parse --abbrev-ref @{upstream} -> throws (no upstream)
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: no upstream configured for branch', 128)
      )
      // getDefaultBranch: symbolic-ref succeeds -> main
      vi.mocked(execa).mockResolvedValueOnce(mockResult('refs/remotes/origin/main'))
      // merge-base fails (e.g., no common ancestor)
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: Not a valid object name', 128)
      )

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })
  })

  describe('edge: upstream merge-base fails', () => {
    it('falls through to default branch when merge-base with upstream fails', async () => {
      // getCurrentBranch -> 'feature/z'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/z'))
      // rev-parse --abbrev-ref @{upstream} -> 'origin/feature/z'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('origin/feature/z'))
      // merge-base HEAD origin/feature/z -> fails
      vi.mocked(execa).mockRejectedValueOnce(
        mockError('fatal: Not a valid object name', 128)
      )
      // Falls through to default branch detection
      // getDefaultBranch: symbolic-ref -> main
      vi.mocked(execa).mockResolvedValueOnce(mockResult('refs/remotes/origin/main'))
      // merge-base HEAD main -> SHA
      vi.mocked(execa).mockResolvedValueOnce(mockResult('11223344'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      expect(result).toEqual({
        cmd: 'git diff 11223344',
        description: 'changes since diverging from main',
      })
    })
  })

  describe('ref validation', () => {
    it('falls back to git diff when upstream ref contains unsafe characters', async () => {
      // getCurrentBranch -> 'feature/x'
      vi.mocked(execa).mockResolvedValueOnce(mockResult('feature/x'))
      // rev-parse --abbrev-ref @{upstream} -> contains shell metacharacters
      vi.mocked(execa).mockResolvedValueOnce(mockResult('origin/$(rm -rf /)'))

      const result = await computeReviewDiffCommand('/repo', defaultProtectedBranches)

      // Returns fallback directly when upstream ref fails validation
      expect(result).toEqual({ cmd: 'git diff', description: 'uncommitted changes' })
    })
  })
})
