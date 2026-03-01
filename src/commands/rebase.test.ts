import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RebaseCommand, WorktreeValidationError } from './rebase.js'
import type { MergeManager } from '../lib/MergeManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import type { BuildRunner } from '../lib/BuildRunner.js'
import type { GitWorktree } from '../types/worktree.js'

// Mock dependencies
vi.mock('../lib/MergeManager.js')
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/SettingsManager.js')
vi.mock('../lib/BuildRunner.js')
vi.mock('../utils/git.js', () => ({
	isValidGitRepo: vi.fn(),
	getWorktreeRoot: vi.fn(),
}))
vi.mock('../utils/package-manager.js', () => ({
	installDependencies: vi.fn(),
}))

// Import mocked functions
import { isValidGitRepo, getWorktreeRoot } from '../utils/git.js'
import { installDependencies } from '../utils/package-manager.js'

describe('RebaseCommand', () => {
	let command: RebaseCommand
	let mockMergeManager: MergeManager
	let mockGitWorktreeManager: GitWorktreeManager
	let mockSettingsManager: SettingsManager
	let mockBuildRunner: BuildRunner
	let originalCwd: typeof process.cwd
	let originalIloomEnv: string | undefined

	// Helper to create mock worktree
	const createMockWorktree = (overrides: Partial<GitWorktree> = {}): GitWorktree => ({
		path: '/test/worktree',
		branch: 'feat/issue-123__test',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
		...overrides,
	})

	beforeEach(() => {
		// Save original cwd and ILOOM env
		originalCwd = process.cwd
		originalIloomEnv = process.env.ILOOM
		delete process.env.ILOOM

		// Create mock MergeManager
		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue({ conflictsDetected: false, claudeLaunched: false, conflictsResolved: false }),
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

		// Create mock BuildRunner
		mockBuildRunner = {
			runBuild: vi.fn().mockResolvedValue({
				success: true,
				skipped: true,
				reason: 'Not a CLI project',
				duration: 0,
			}),
		} as unknown as BuildRunner

		// Create command with mocked dependencies
		command = new RebaseCommand(mockMergeManager, mockGitWorktreeManager, mockSettingsManager, mockBuildRunner)
	})

	afterEach(() => {
		process.cwd = originalCwd
		// Restore ILOOM env
		if (originalIloomEnv !== undefined) {
			process.env.ILOOM = originalIloomEnv
		} else {
			delete process.env.ILOOM
		}
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
			vi.mocked(getWorktreeRoot).mockResolvedValue(null)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('Could not determine repository root.')
		})

		it('throws error when directory is not a registered worktree', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/regular-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/regular-repo')
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
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/main-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([mainWorktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(true)

			await expect(command.execute()).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute()).rejects.toThrow('Cannot rebase from the main worktree.')
		})

		it('works from subdirectory within valid worktree', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree/src/components')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			// Should use repo root, not the subdirectory
			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
				jsonStream: false,
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
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/regular-repo')
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
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/main-repo')
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
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('sets ILOOM=1 in process.env during execute', async () => {
			// Verify ILOOM is not set before execute
			expect(process.env.ILOOM).toBeUndefined()

			await command.execute()

			// Verify ILOOM is set after execute
			expect(process.env.ILOOM).toBe('1')
		})

		it('calls rebaseOnMain with worktree path', async () => {
			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
				jsonStream: false,
			})
		})

		it('succeeds when branch is already up to date', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue({ conflictsDetected: false, claudeLaunched: false, conflictsResolved: false })

			await expect(command.execute()).resolves.toBeUndefined()
		})

		it('succeeds when rebase completes without conflicts', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue({ conflictsDetected: false, claudeLaunched: false, conflictsResolved: false })

			await expect(command.execute()).resolves.toBeUndefined()
		})

		it('handles rebase conflicts by launching Claude (via MergeManager)', async () => {
			// MergeManager.rebaseOnMain handles Claude conflict resolution internally
			// It only throws if conflicts cannot be resolved
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue({ conflictsDetected: false, claudeLaunched: false, conflictsResolved: false })

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
				jsonStream: false,
			})
		})

		it('handles force mode', async () => {
			await command.execute({ force: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: true,
				jsonStream: false,
			})
		})

		it('handles both dry-run and force mode together', async () => {
			await command.execute({ dryRun: true, force: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: true,
				force: true,
				jsonStream: false,
			})
		})

		it('calls installDependencies after successful rebase', async () => {
			await command.execute()

			expect(installDependencies).toHaveBeenCalledWith('/test/worktree', true, true)
		})

		it('skips dependency installation in dry-run mode', async () => {
			await command.execute({ dryRun: true })

			expect(installDependencies).not.toHaveBeenCalled()
		})

		it('does not fail when dependency installation fails', async () => {
			vi.mocked(installDependencies).mockRejectedValue(new Error('npm install failed'))

			// Should not throw - rebase succeeded, installation failure is just a warning
			await expect(command.execute()).resolves.toBeUndefined()
			expect(installDependencies).toHaveBeenCalledWith('/test/worktree', true, true)
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
				branch: 'feat/issue-123__feature',
			})
			process.cwd = vi.fn().mockReturnValue('/test/feat-issue-123')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/feat-issue-123')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				mainWorktree,
				featureWorktree,
			])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/feat-issue-123', {
				dryRun: false,
				force: false,
				jsonStream: false,
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
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)

			await command.execute()

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
				jsonStream: false,
			})
		})
	})

	describe('post-rebase build', () => {
		beforeEach(() => {
			// Setup valid worktree context for all build tests
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('runs build after successful rebase for CLI projects', async () => {
			// Mock BuildRunner to indicate successful build
			vi.mocked(mockBuildRunner.runBuild).mockResolvedValue({
				success: true,
				skipped: false,
				duration: 1500,
			})

			await command.execute()

			// Verify buildRunner.runBuild was called with correct parameters
			expect(mockBuildRunner.runBuild).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
			})
		})

		it('skips build when project is not a CLI project', async () => {
			// Mock BuildRunner to indicate build was skipped
			vi.mocked(mockBuildRunner.runBuild).mockResolvedValue({
				success: true,
				skipped: true,
				reason: 'Project is not a CLI project (no bin field in package.json)',
				duration: 50,
			})

			await command.execute()

			expect(mockBuildRunner.runBuild).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
			})
		})

		it('skips build in dry-run mode', async () => {
			await command.execute({ dryRun: true })

			// BuildRunner.runBuild should NOT be called in dry-run mode
			// because the command exits early with a log message
			expect(mockBuildRunner.runBuild).not.toHaveBeenCalled()
		})

		it('logs warning but does not fail when build fails', async () => {
			// Mock BuildRunner to throw an error
			vi.mocked(mockBuildRunner.runBuild).mockRejectedValue(
				new Error('Build failed: TypeScript compilation errors')
			)

			// Should not throw - rebase succeeded, build failure is just a warning
			await expect(command.execute()).resolves.toBeUndefined()

			// Verify buildRunner.runBuild was called
			expect(mockBuildRunner.runBuild).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
			})
		})

		it('runs build after dependency installation', async () => {
			const executionOrder: string[] = []

			vi.mocked(installDependencies).mockImplementation(async () => {
				executionOrder.push('install')
			})

			vi.mocked(mockBuildRunner.runBuild).mockImplementation(async () => {
				executionOrder.push('build')
				return {
					success: true,
					skipped: false,
					duration: 1000,
				}
			})

			await command.execute()

			// Verify install happens before build
			const installIndex = executionOrder.indexOf('install')
			const buildIndex = executionOrder.indexOf('build')

			expect(installIndex).toBeGreaterThanOrEqual(0)
			expect(buildIndex).toBeGreaterThanOrEqual(0)
			expect(installIndex).toBeLessThan(buildIndex)
		})

		it('does not run build when rebase fails', async () => {
			// Mock rebaseOnMain to throw an error
			vi.mocked(mockMergeManager.rebaseOnMain).mockRejectedValue(
				new Error('Rebase failed: merge conflict')
			)

			await expect(command.execute()).rejects.toThrow('Rebase failed: merge conflict')

			// BuildRunner should not be called if rebase fails
			expect(mockBuildRunner.runBuild).not.toHaveBeenCalled()
		})

		it('runs build even when dependency installation fails', async () => {
			// Mock dependency installation to fail
			vi.mocked(installDependencies).mockRejectedValue(
				new Error('npm install failed: lockfile out of date')
			)

			vi.mocked(mockBuildRunner.runBuild).mockResolvedValue({
				success: true,
				skipped: false,
				duration: 1000,
			})

			// Should not throw - both installation and build failures are warnings
			await expect(command.execute()).resolves.toBeUndefined()

			// BuildRunner should still be called after dependency installation failure
			expect(mockBuildRunner.runBuild).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
			})
		})

		it('passes dryRun option to BuildRunner when provided', async () => {
			// Note: In the current implementation, build is skipped entirely in dry-run mode
			// This test documents that behavior
			await command.execute({ dryRun: true })

			// BuildRunner is not called in dry-run mode because the command returns early
			expect(mockBuildRunner.runBuild).not.toHaveBeenCalled()
		})
	})

	describe('execute with jsonStream', () => {
		beforeEach(() => {
			// Setup valid worktree context
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('should pass jsonStream through mergeOptions to rebaseOnMain', async () => {
			await command.execute({ jsonStream: true })

			expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith('/test/worktree', {
				dryRun: false,
				force: false,
				jsonStream: true,
			})
		})

		it('should return RebaseResult when jsonStream is true', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue({
				conflictsDetected: true,
				claudeLaunched: true,
				conflictsResolved: true,
			})

			const result = await command.execute({ jsonStream: true })

			expect(result).toEqual({
				success: true,
				conflictsDetected: true,
				claudeLaunched: true,
				conflictsResolved: true,
			})
		})

		it('should return void when jsonStream is not set (existing behavior)', async () => {
			const result = await command.execute({})

			expect(result).toBeUndefined()
		})

		it('should throw WorktreeValidationError when jsonStream is true so cli.ts can format error and exit(1)', async () => {
			process.cwd = vi.fn().mockReturnValue('/tmp/not-a-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(false)

			await expect(command.execute({ jsonStream: true })).rejects.toThrow(WorktreeValidationError)
		})

		it('should return RebaseResult with no conflicts when rebase is clean', async () => {
			vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue({
				conflictsDetected: false,
				claudeLaunched: false,
				conflictsResolved: false,
			})

			const result = await command.execute({ jsonStream: true })

			expect(result).toEqual({
				success: true,
				conflictsDetected: false,
				claudeLaunched: false,
				conflictsResolved: false,
			})
		})
	})
})
