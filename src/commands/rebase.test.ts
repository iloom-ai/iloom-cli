import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RebaseCommand, WorktreeValidationError } from './rebase.js'
import type { MergeManager } from '../lib/MergeManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import type { GitWorktree } from '../types/worktree.js'

// Mock dependencies
vi.mock('../lib/MergeManager.js')
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/SettingsManager.js')
vi.mock('../utils/git.js', () => ({
	isValidGitRepo: vi.fn(),
	getRepoRoot: vi.fn(),
}))

// Import mocked functions
import { isValidGitRepo, getRepoRoot } from '../utils/git.js'

describe('RebaseCommand', () => {
	let command: RebaseCommand
	let mockMergeManager: MergeManager
	let mockGitWorktreeManager: GitWorktreeManager
	let mockSettingsManager: SettingsManager
	let originalCwd: typeof process.cwd

	// Helper to create mock worktree
	const createMockWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
		path: '/test/worktree',
		branch: 'feat/issue-123-test',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
		...overrides,
	})

	beforeEach(() => {
		// Save original cwd
		originalCwd = process.cwd

		// Create mock MergeManager
		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		// Create mock GitWorktreeManager
		mockGitWorktreeManager = {
			listWorktrees: vi.fn(),
			isMainWorktree: vi.fn(),
		} as unknown as GitWorktreeManager

		// Create mock SettingsManager
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({}),
			getProtectedBranches: vi.fn().mockResolvedValue(['main', 'master', 'develop']),
		} as unknown as SettingsManager

		// Create command with mocked dependencies
		command = new RebaseCommand(mockMergeManager, mockGitWorktreeManager, mockSettingsManager)
	})

	afterEach(() => {
		process.cwd = originalCwd
	})

	describe('WorktreeValidationError', () => {
		it('creates error with message and suggestion', () => {
			const error = new WorktreeValidationError('Test message', 'Test suggestion')
			expect(error.message).toBe('Test message')
			expect(error.suggestion).toBe('Test suggestion')
			expect(error.name).toBe('WorktreeValidationError')
		})
	})

	describe('worktree validation', () => {
		it('throws error when not in a git repository', async () => {
			process.cwd = vi.fn().mockReturnValue('/tmp/not-a-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(false)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('Not a git repository.')
		})

		it('throws error when repo root cannot be determined', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue(null)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('Could not determine repository root.')
		})

		it('throws error when directory is not a registered worktree', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/regular-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/regular-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				createMockWorktree({ path: '/other/worktree' }),
			])

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('This directory is not an iloom worktree.')
		})

		it('throws error when running from main worktree', async () => {
			const mainWorktree = createMockWorktree({
				path: '/test/main-repo',
				branch: 'main',
				bare: true,
			})
			process.cwd = vi.fn().mockReturnValue('/test/main-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/main-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([mainWorktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(true)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('Cannot rebase from the main worktree.')
		})

		it('works from subdirectory within valid worktree', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree/src/components')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			// Should use repo root, not the subdirectory
			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
			})
		})

		it('provides helpful suggestion for non-git directory', async () => {
			process.cwd = vi.fn().mockReturnValue('/tmp/not-a-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(false)

			try {
				await command.execute()
				expect.fail('Expected WorktreeValidationError')
			} catch (error) {
				expect(error).toBeInstanceOf(WorktreeValidationError)
				expect((error as WorktreeValidationError).suggestion).toContain("'il start'")
			}
		})

		it('provides helpful suggestion for regular git repo', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/regular-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/regular-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([])

			try {
				await command.execute()
				expect.fail('Expected WorktreeValidationError')
			} catch (error) {
				expect(error).toBeInstanceOf(WorktreeValidationError)
				expect((error as WorktreeValidationError).suggestion).toContain("'il list'")
			}
		})

		it('provides helpful suggestion for main worktree', async () => {
			const mainWorktree = createMockWorktree({
				path: '/test/main-repo',
				branch: 'main',
			})
			process.cwd = vi.fn().mockReturnValue('/test/main-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/main-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([mainWorktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(true)

			try {
				await command.execute()
				expect.fail('Expected WorktreeValidationError')
			} catch (error) {
				expect(error).toBeInstanceOf(WorktreeValidationError)
				expect((error as WorktreeValidationError).suggestion).toContain('Navigate to a feature worktree')
			}
		})
	})

	describe('execute with valid worktree', () => {
		beforeEach(() => {
			// Setup valid worktree context
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('calls rebaseOnMain with worktree path', async () => {
			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
			})
		})

		it('succeeds when branch is already up to date', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue(undefined)

			await expect(command.execute()).resolves.toBeUndefined()
		})

		it('succeeds when rebase completes without conflicts', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue(undefined)

			await expect(command.execute()).resolves.toBeUndefined()
		})

		it('handles rebase conflicts by launching Claude (via MergeManager)', async () => {
			// MergeManager.rebaseOnMain handles Claude conflict resolution internally
			// It only throws if conflicts cannot be resolved
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue(undefined)

			await expect(command.execute()).resolves.toBeUndefined()
		})

		it('propagates MergeManager errors', async () => {
			const mergeError = new Error('Rebase failed: merge conflict')
			vi.mocked(mockMergeManager.rebaseOnMain).mockRejectedValue(mergeError)

			await expect(command.execute()).rejects.toThrow('Rebase failed: merge conflict')
		})

		it('handles dry-run mode', async () => {
			await command.execute({ dryRun: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: true,
				force: false,
			})
		})

		it('handles force mode', async () => {
			await command.execute({ force: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: true,
			})
		})

		it('handles both dry-run and force mode together', async () => {
			await command.execute({ dryRun: true, force: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: true,
				force: true,
			})
		})
	})

	describe('edge cases', () => {
		it('handles worktree with multiple worktrees registered', async () => {
			const mainWorktree = createMockWorktree({
				path: '/test/main',
				branch: 'main',
			})
			const featureWorktree = createMockWorktree({
				path: '/test/feat-issue-123',
				branch: 'feat/issue-123-feature',
			})
			process.cwd = vi.fn().mockReturnValue('/test/feat-issue-123')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/feat-issue-123')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				mainWorktree,
				featureWorktree,
			])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/feat-issue-123', {
				dryRun: false,
				force: false,
			})
		})

		it('validates before calling rebaseOnMain', async () => {
			process.cwd = vi.fn().mockReturnValue('/tmp/not-a-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(false)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)

			// rebaseOnMain should not be called if validation fails
			expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		})

		it('handles deeply nested subdirectory within worktree', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree/src/lib/utils/deep/nested')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getRepoRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
			})
		})
	})
})
