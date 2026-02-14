import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CommitCommand, WorktreeValidationError } from './commit.js'
import type { CommitManager } from '../lib/CommitManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { SettingsManager } from '../lib/SettingsManager.js'
import type { MetadataManager } from '../lib/MetadataManager.js'
import type { ValidationRunner } from '../lib/ValidationRunner.js'
import type { GitWorktree } from '../types/worktree.js'
import type { GitStatus } from '../types/index.js'

// Mock dependencies
vi.mock('../lib/CommitManager.js')
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/SettingsManager.js')
vi.mock('../lib/MetadataManager.js')
vi.mock('../lib/ValidationRunner.js')
vi.mock('../lib/IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		formatIssueId: vi.fn((provider: string, id: string | number) => {
			if (provider === 'github') return `#${id}`
			return String(id).toUpperCase()
		}),
	},
}))
vi.mock('../utils/git.js', () => ({
	isValidGitRepo: vi.fn(),
	getWorktreeRoot: vi.fn(),
	extractIssueNumber: vi.fn(),
}))

// Import mocked functions
import { isValidGitRepo, getWorktreeRoot, extractIssueNumber } from '../utils/git.js'

describe('CommitCommand', () => {
	let command: CommitCommand
	let mockCommitManager: CommitManager
	let mockGitWorktreeManager: GitWorktreeManager
	let mockSettingsManager: SettingsManager
	let mockMetadataManager: MetadataManager
	let mockValidationRunner: ValidationRunner
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

	// Helper to create mock git status
	const createMockGitStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
		hasUncommittedChanges: true,
		unstagedFiles: ['file1.ts'],
		stagedFiles: [],
		currentBranch: 'feat/issue-123__test',
		isAheadOfRemote: false,
		isBehindRemote: false,
		...overrides,
	})

	beforeEach(() => {
		// Save original cwd and ILOOM env
		originalCwd = process.cwd
		originalIloomEnv = process.env.ILOOM
		delete process.env.ILOOM

		// IssueTrackerFactory.formatIssueId is already mocked via vi.mock above

		// Create mock CommitManager
		mockCommitManager = {
			detectUncommittedChanges: vi.fn().mockResolvedValue(createMockGitStatus()),
			commitChanges: vi.fn().mockResolvedValue({ message: 'Test commit message\n\nRefs #123' }),
		} as unknown as CommitManager

		// Create mock GitWorktreeManager
		mockGitWorktreeManager = {
			listWorktrees: vi.fn(),
			isMainWorktree: vi.fn(),
			getRepoInfo: vi.fn().mockResolvedValue({ currentBranch: 'feat/issue-123__test' }),
		} as unknown as GitWorktreeManager

		// Create mock SettingsManager
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({
				issueManagement: { provider: 'github' },
				workflows: { issue: { noVerify: false } },
			}),
		} as unknown as SettingsManager

		// Create mock MetadataManager
		mockMetadataManager = {
			readMetadata: vi.fn().mockResolvedValue({
				issue_numbers: [123],
				issueType: 'issue',
			}),
		} as unknown as MetadataManager

		// Create mock ValidationRunner
		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue({ success: true, steps: [], totalDuration: 100 }),
		} as unknown as ValidationRunner

		// Create command with mocked dependencies
		command = new CommitCommand(
			mockGitWorktreeManager,
			mockCommitManager,
			mockSettingsManager,
			mockMetadataManager,
			mockValidationRunner
		)
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

			await expect(command.execute({})).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute({})).rejects.toThrow('Not a git repository.')
		})

		it('throws error when repo root cannot be determined', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue(null)

			await expect(command.execute({})).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute({})).rejects.toThrow('Could not determine repository root.')
		})

		it('throws error when directory is not a registered worktree', async () => {
			process.cwd = vi.fn().mockReturnValue('/test/regular-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/regular-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([
				createMockWorktree({ path: '/other/worktree' }),
			])

			await expect(command.execute({})).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute({})).rejects.toThrow('This directory is not an iloom worktree.')
		})

		it('throws error when running from main worktree', async () => {
			const mainWorktree = createMockWorktree({
				path: '/test/main-repo',
				branch: 'main',
			})
			process.cwd = vi.fn().mockReturnValue('/test/main-repo')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/main-repo')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([mainWorktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(true)

			await expect(command.execute({})).rejects.toThrow(WorktreeValidationError)
			await expect(command.execute({})).rejects.toThrow('Cannot use il commit from the main worktree.')
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
			vi.mocked(extractIssueNumber).mockReturnValue(123)
		})

		it('sets ILOOM=1 in process.env during execute', async () => {
			// Verify ILOOM is not set before execute
			expect(process.env.ILOOM).toBeUndefined()

			await command.execute({})

			// Verify ILOOM is set after execute
			expect(process.env.ILOOM).toBe('1')
		})

		it('commits with Refs trailer by default', async () => {
			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					trailerType: 'Refs',
					issueNumber: 123,
					issuePrefix: '#',
				})
			)
		})

		it('commits with Fixes trailer when --fixes flag provided', async () => {
			await command.execute({ fixes: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					trailerType: 'Fixes',
					issueNumber: 123,
				})
			)
		})

		it('uses custom message with -m flag', async () => {
			await command.execute({ message: 'Custom commit message' })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					message: 'Custom commit message',
				})
			)
		})

		it('skips review with --no-review flag', async () => {
			await command.execute({ noReview: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					noReview: true,
				})
			)
		})

		it('returns JSON output with --json flag including commit message', async () => {
			const result = await command.execute({ json: true })

			expect(result).toEqual({
				success: true,
				trailerType: 'Refs',
				issueNumber: 123,
				message: 'Test commit message\n\nRefs #123',
			})
		})

		it('returns void when not in JSON mode', async () => {
			const result = await command.execute({})

			expect(result).toBeUndefined()
		})

		it('handles no uncommitted changes gracefully', async () => {
			vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue(
				createMockGitStatus({ hasUncommittedChanges: false })
			)

			const result = await command.execute({ json: true })

			expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
			expect(result).toEqual({
				success: true,
				trailerType: 'Refs',
				issueNumber: 123,
			})
		})
	})

	describe('auto-detect issue', () => {
		beforeEach(() => {
			const worktree = createMockWorktree({ path: '/test/issue-123__feature' })
			process.cwd = vi.fn().mockReturnValue('/test/issue-123__feature')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/issue-123__feature')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('detects issue from directory name pattern issue-N__', async () => {
			vi.mocked(extractIssueNumber).mockReturnValue(123)

			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/issue-123__feature',
				expect.objectContaining({
					issueNumber: 123,
				})
			)
		})

		it('detects PR from _pr_N suffix', async () => {
			const prWorktree = createMockWorktree({ path: '/test/issue-123__feature_pr_456' })
			process.cwd = vi.fn().mockReturnValue('/test/issue-123__feature_pr_456')
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/issue-123__feature_pr_456')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([prWorktree])
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				pr_numbers: [456],
				issueType: 'pr',
			})

			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/issue-123__feature_pr_456',
				expect.objectContaining({
					issueNumber: 456,
				})
			)
		})

		it('detects issue from branch name when not in directory pattern', async () => {
			vi.mocked(extractIssueNumber).mockReturnValueOnce(null).mockReturnValueOnce(789)
			vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
				currentBranch: 'feat/issue-789__feature',
			})
			// Mock metadata to not contain issue_numbers so branch detection is used
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				issueType: 'issue',
			})

			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/issue-123__feature',
				expect.objectContaining({
					issueNumber: 789,
				})
			)
		})

		it('handles branch-only worktrees without issue number', async () => {
			vi.mocked(extractIssueNumber).mockReturnValue(null)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				issueType: 'branch',
			})

			await command.execute({})

			// Should still commit, just without issue number
			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/issue-123__feature',
				expect.objectContaining({
					trailerType: 'Refs',
				})
			)
			// Verify issueNumber is not in the call
			const callArgs = vi.mocked(mockCommitManager.commitChanges).mock.calls[0][1]
			expect(callArgs.issueNumber).toBeUndefined()
		})
	})

	describe('--fixes flag behavior', () => {
		beforeEach(() => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
		})

		it('warns and ignores --fixes when not in issue/PR worktree', async () => {
			vi.mocked(extractIssueNumber).mockReturnValue(null)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				issueType: 'branch',
			})

			await command.execute({ fixes: true })

			// Should still use Refs, not Fixes
			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					trailerType: 'Refs',
				})
			)
		})

		it('uses Fixes trailer when in issue worktree with --fixes', async () => {
			vi.mocked(extractIssueNumber).mockReturnValue(123)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				issue_numbers: [123],
				issueType: 'issue',
			})

			await command.execute({ fixes: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					trailerType: 'Fixes',
					issueNumber: 123,
				})
			)
		})

		it('uses Fixes trailer when in PR worktree with --fixes', async () => {
			const prWorktree = createMockWorktree({ path: '/test/worktree_pr_456' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree_pr_456')
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree_pr_456')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([prWorktree])
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				pr_numbers: [456],
				issueType: 'pr',
			})

			await command.execute({ fixes: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree_pr_456',
				expect.objectContaining({
					trailerType: 'Fixes',
				})
			)
		})
	})

	describe('validation', () => {
		beforeEach(() => {
			// Setup valid worktree context for validation tests
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
			vi.mocked(extractIssueNumber).mockReturnValue(123)
		})

		it('runs validations before committing by default', async () => {
			await command.execute({})

			expect(mockValidationRunner.runValidations).toHaveBeenCalledWith('/test/worktree', { dryRun: false })
			expect(mockCommitManager.commitChanges).toHaveBeenCalled()
		})

		it('does not commit when validation fails', async () => {
			vi.mocked(mockValidationRunner.runValidations).mockResolvedValue({ success: false, steps: [], totalDuration: 100 })

			await expect(command.execute({})).rejects.toThrow('Validation failed. Fix errors before committing.')
			expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
		})

		it('skips validation and hooks with --wip-commit flag', async () => {
			await command.execute({ wipCommit: true })

			expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					skipVerify: true, // --wip-commit also skips pre-commit hooks
				})
			)
		})

		it('uses hardcoded WIP message with --wip-commit when no custom message provided', async () => {
			await command.execute({ wipCommit: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					message: 'WIP commit for Issue #123',
				})
			)
		})

		it('uses custom message with --wip-commit when -m is provided', async () => {
			await command.execute({ wipCommit: true, message: 'Custom WIP message' })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					message: 'Custom WIP message',
				})
			)
		})

		it('uses simple WIP message without issue number for branch loom', async () => {
			vi.mocked(extractIssueNumber).mockReturnValue(null)
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				issueType: 'branch',
			})

			await command.execute({ wipCommit: true })

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					message: 'WIP commit',
				})
			)
		})

		it('honors noVerify setting after validation passes', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				issueManagement: { provider: 'github' },
				workflows: { issue: { noVerify: true } },
			})

			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					skipVerify: true,
				})
			)
		})
	})

	describe('edge cases', () => {
		it('works from subdirectory within valid worktree', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree/src/components')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
			vi.mocked(extractIssueNumber).mockReturnValue(123)

			await command.execute({})

			// Should use repo root, not the subdirectory
			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					issueNumber: 123,
				})
			)
		})

		it('respects noVerify setting from settings when validation passes', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
			vi.mocked(extractIssueNumber).mockReturnValue(123)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				issueManagement: { provider: 'github' },
				workflows: { issue: { noVerify: true } },
			})
			// Validation passes by default (mock returns success: true)

			await command.execute({})

			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					skipVerify: true,
				})
			)
		})

		it('always skips hooks with --wip-commit regardless of noVerify setting', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
			vi.mocked(extractIssueNumber).mockReturnValue(123)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				issueManagement: { provider: 'github' },
				workflows: { issue: { noVerify: false } }, // noVerify is false
			})

			await command.execute({ wipCommit: true })

			// --wip-commit always skips hooks, regardless of noVerify setting
			expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
				'/test/worktree',
				expect.objectContaining({
					skipVerify: true,
				})
			)
		})

		it('propagates CommitManager errors', async () => {
			const worktree = createMockWorktree({ path: '/test/worktree' })
			process.cwd = vi.fn().mockReturnValue('/test/worktree')
			vi.mocked(isValidGitRepo).mockResolvedValue(true)
			vi.mocked(getWorktreeRoot).mockResolvedValue('/test/worktree')
			vi.mocked(mockGitWorktreeManager.listWorktrees).mockResolvedValue([worktree])
			vi.mocked(mockGitWorktreeManager.isMainWorktree).mockResolvedValue(false)
			vi.mocked(extractIssueNumber).mockReturnValue(123)

			const commitError = new Error('Pre-commit hook failed')
			vi.mocked(mockCommitManager.commitChanges).mockRejectedValue(commitError)

			await expect(command.execute({})).rejects.toThrow('Pre-commit hook failed')
		})
	})
})
