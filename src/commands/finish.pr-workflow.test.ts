import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FinishCommand } from '../../src/commands/finish.js'
import { GitHubService } from '../../src/lib/GitHubService.js'
import { GitWorktreeManager } from '../../src/lib/GitWorktreeManager.js'
import { ValidationRunner } from '../../src/lib/ValidationRunner.js'
import { CommitManager } from '../../src/lib/CommitManager.js'
import { MergeManager } from '../../src/lib/MergeManager.js'
import { IdentifierParser } from '../../src/utils/IdentifierParser.js'
import { ResourceCleanup } from '../../src/lib/ResourceCleanup.js'
import { BuildRunner } from '../../src/lib/BuildRunner.js'
import { SettingsManager } from '../../src/lib/SettingsManager.js'
import type { PullRequest, Issue, GitWorktree } from '../../src/types/index.js'
import { pushBranchToRemote, getMergeTargetBranch } from '../../src/utils/git.js'

// Mock TelemetryService to prevent real PostHog events during tests
const mockTrack = vi.fn()
vi.mock('../../src/lib/TelemetryService.js', () => ({
	TelemetryService: {
		getInstance: () => ({ track: mockTrack }),
	},
}))

// Mock MetadataManager for telemetry duration calculation
const mockReadMetadata = vi.fn().mockResolvedValue(null)
vi.mock('../../src/lib/MetadataManager.js', () => ({
	MetadataManager: vi.fn(() => ({
		readMetadata: mockReadMetadata,
		archiveMetadata: vi.fn().mockResolvedValue(undefined),
	})),
}))

// Mock git utils module for pushBranchToRemote, findMainWorktreePathWithSettings, and getMergeTargetBranch
vi.mock('../../src/utils/git.js', async () => {
	const actual = await vi.importActual<typeof import('../../src/utils/git.js')>('../../src/utils/git.js')
	return {
		...actual,
		pushBranchToRemote: vi.fn().mockResolvedValue(undefined),
		findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/test/main'),
		getMergeTargetBranch: vi.fn().mockResolvedValue('main'),
		// Prevent real git commands from running during tests
		executeGitCommand: vi.fn().mockResolvedValue(''),
	}
})

// Mock remote utilities
vi.mock('../../src/utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn().mockResolvedValue(false),
	getConfiguredRepoFromSettings: vi.fn().mockResolvedValue('owner/repo'),
}))

// Mock SettingsManager to prevent reading actual settings files
vi.mock('../../src/lib/SettingsManager.js', () => {
	return {
		SettingsManager: class MockSettingsManager {
			async loadSettings() {
				return {}
			}
		},
	}
})

describe('FinishCommand - PR State Detection', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-pr-123_pr_123',
		branch: 'feat-pr-123',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn(),
			fetchIssue: vi.fn(),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForBranch: vi.fn().mockResolvedValue(mockWorktree),
			getRepoInfo: vi.fn().mockResolvedValue({
				root: '/test/repo',
				currentBranch: 'main',
			}),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn().mockResolvedValue({
				hasUncommittedChanges: false,
				unstagedFiles: [],
				stagedFiles: [],
				currentBranch: 'feat-pr-123',
				isAheadOfRemote: false,
				isBehindRemote: false,
			}),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn(),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '123',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should detect open PR state correctly', async () => {
		const mockPR: PullRequest = {
			number: 123,
			title: 'Test PR',
			body: 'Test body',
			state: 'open',
			branch: 'feat-pr-123',
			baseBranch: 'main',
			url: 'https://github.com/test/repo/pull/123',
			isDraft: false,
		}

		vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify PR was fetched (called twice - once in validation, once in execute)
		expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)

		// Verify validation/merge NOT called for PR workflow
		expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
		expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
	})

	it('should detect closed PR state correctly', async () => {
		const mockPR: PullRequest = {
			number: 123,
			title: 'Test PR',
			body: 'Test body',
			state: 'closed',
			branch: 'feat-pr-123',
			baseBranch: 'main',
			url: 'https://github.com/test/repo/pull/123',
			isDraft: false,
		}

		vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup workflow was executed
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()

		// Verify merge workflow was NOT executed
		expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
	})

	it('should detect merged PR state correctly', async () => {
		const mockPR: PullRequest = {
			number: 123,
			title: 'Test PR',
			body: 'Test body',
			state: 'merged',
			branch: 'feat-pr-123',
			baseBranch: 'main',
			url: 'https://github.com/test/repo/pull/123',
			isDraft: false,
		}

		vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup workflow was executed
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()

		// Verify merge workflow was NOT executed
		expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
	})
})

describe('FinishCommand - Open PR Workflow', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-pr-123_pr_123',
		branch: 'feat-pr-123',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const mockOpenPR: PullRequest = {
		number: 123,
		title: 'Test PR',
		body: 'Test body',
		state: 'open',
		branch: 'feat-pr-123',
		baseBranch: 'main',
		url: 'https://github.com/test/repo/pull/123',
		isDraft: false,
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn().mockResolvedValue(mockOpenPR),
			fetchIssue: vi.fn(),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForBranch: vi.fn().mockResolvedValue(mockWorktree),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn(),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn(),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '123',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should commit uncommitted changes before pushing for open PR', async () => {
		// Mock uncommitted changes exist
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: true,
			unstagedFiles: ['file1.ts', 'file2.ts'],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify commit was called
		expect(mockCommitManager.commitChanges).toHaveBeenCalledWith(
			mockWorktree.path,
			expect.objectContaining({
				dryRun: false,
				// Should NOT include issueNumber for PRs
			})
		)

		// Verify issueNumber was NOT passed
		const commitCall = vi.mocked(mockCommitManager.commitChanges).mock.calls[0]
		expect(commitCall?.[1]).not.toHaveProperty('issueNumber')

		// Verify push was called (from mocked git utils)
		expect(pushBranchToRemote).toHaveBeenCalledWith(
			mockOpenPR.branch,
			mockWorktree.path,
			expect.objectContaining({ dryRun: false })
		)
	})

	it('should push changes to remote for open PR', async () => {
		// Mock no uncommitted changes
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify push was called with correct parameters
		expect(pushBranchToRemote).toHaveBeenCalledWith(
			mockOpenPR.branch,
			mockWorktree.path,
			expect.objectContaining({ dryRun: false })
		)
	})

	it('should keep worktree active after push for open PR', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup was NOT called for open PRs
		expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
	})

	it('should handle push failure gracefully for open PR', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		// Mock push failure
		vi.mocked(pushBranchToRemote).mockRejectedValue(
			new Error('Failed to push to remote: rejected by remote')
		)

		// Verify error is thrown (not swallowed)
		await expect(
			finishCommand.execute({
				identifier: undefined,
				options: { pr: 123 },
			})
		).rejects.toThrow('Failed to push to remote')
	})

	it('should skip validation for open PR workflow', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify validation was NOT called
		expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
	})
})

describe('FinishCommand - Child Loom GitHub PR Workflow', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-issue-456',
		branch: 'feat-issue-456',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const mockIssue: Issue = {
		number: 456,
		title: 'Child Issue',
		body: 'Child issue body',
		state: 'open',
		url: 'https://github.com/test/repo/issues/456',
		labels: [],
		assignees: [],
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn(),
			fetchIssue: vi.fn().mockResolvedValue(mockIssue),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForBranch: vi.fn().mockResolvedValue(mockWorktree),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn().mockResolvedValue({
				hasUncommittedChanges: false,
				unstagedFiles: [],
				stagedFiles: [],
				currentBranch: 'feat-issue-456',
				isAheadOfRemote: false,
				isBehindRemote: false,
			}),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn().mockResolvedValue({
				type: 'issue',
				number: 456,
				originalInput: '456',
			}),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '456',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should use parent loom branch as PR base for child looms', async () => {
		// Mock getMergeTargetBranch to return parent branch (simulating child loom metadata)
		vi.mocked(getMergeTargetBranch).mockResolvedValue('feat/issue-123-parent-feature')

		// Mock SettingsManager to return github-pr mode
		const mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({
				mergeBehavior: { mode: 'pr' },
			}),
		}

		// Replace settingsManager via constructor
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup,
			undefined, // buildRunner
			mockSettingsManager as unknown as SettingsManager
		)

		// Execute in dry-run mode to avoid PRManager instantiation
		await finishCommand.execute({
			identifier: '456',
			options: { dryRun: true },
		})

		// Verify getMergeTargetBranch was called with worktree path
		expect(getMergeTargetBranch).toHaveBeenCalledWith(mockWorktree.path)
	})
})

describe('FinishCommand - Closed PR Workflow', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-pr-123_pr_123',
		branch: 'feat-pr-123',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const mockClosedPR: PullRequest = {
		number: 123,
		title: 'Test PR',
		body: 'Test body',
		state: 'closed',
		branch: 'feat-pr-123',
		baseBranch: 'main',
		url: 'https://github.com/test/repo/pull/123',
		isDraft: false,
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn().mockResolvedValue(mockClosedPR),
			fetchIssue: vi.fn(),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForBranch: vi.fn().mockResolvedValue(mockWorktree),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn(),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn(),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '123',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should skip all merge steps for closed PR', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify validation and merge steps NOT called
		expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
		expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
	})

	it('should call cleanup directly for closed PR', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup was called
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'pr',
				number: 123,
			}),
			expect.objectContaining({
				deleteBranch: true,
				keepDatabase: false,
			})
		)
	})

	it('should delete branch for closed PR', async () => {
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup called with deleteBranch: true
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				deleteBranch: true,
			})
		)
	})

	it('should warn about uncommitted changes in closed PR before cleanup', async () => {
		// Mock uncommitted changes exist
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: true,
			unstagedFiles: ['file1.ts'],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		// Should throw error without --force
		await expect(
			finishCommand.execute({
				identifier: undefined,
				options: { pr: 123 },
			})
		).rejects.toThrow('Cannot cleanup PR with uncommitted changes')

		// Verify cleanup was NOT called
		expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
	})

	it('should allow cleanup with --force even with uncommitted changes', async () => {
		// Mock uncommitted changes exist
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: true,
			unstagedFiles: ['file1.ts'],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		// Should succeed with --force
		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123, force: true },
		})

		// Verify cleanup was called
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
	})
})

describe('FinishCommand - Merged PR Workflow', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-pr-123_pr_123',
		branch: 'feat-pr-123',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const mockMergedPR: PullRequest = {
		number: 123,
		title: 'Test PR',
		body: 'Test body',
		state: 'merged',
		branch: 'feat-pr-123',
		baseBranch: 'main',
		url: 'https://github.com/test/repo/pull/123',
		isDraft: false,
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn().mockResolvedValue(mockMergedPR),
			fetchIssue: vi.fn(),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn().mockResolvedValue({
				hasUncommittedChanges: false,
				unstagedFiles: [],
				stagedFiles: [],
				currentBranch: 'feat-pr-123',
				isAheadOfRemote: false,
				isBehindRemote: false,
			}),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn(),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '123',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should handle merged PR same as closed PR', async () => {
		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123 },
		})

		// Verify cleanup was called (same as closed PR)
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()

		// Verify merge workflow was NOT executed
		expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
	})
})

describe('FinishCommand - Dry-Run Mode for PRs', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-pr-123_pr_123',
		branch: 'feat-pr-123',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn(),
			fetchIssue: vi.fn(),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn().mockResolvedValue(mockWorktree),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn(),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn(),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '123',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup
		)
	})

	it('should log all operations without executing for open PR dry-run', async () => {
		const mockOpenPR: PullRequest = {
			number: 123,
			title: 'Test PR',
			body: 'Test body',
			state: 'open',
			branch: 'feat-pr-123',
			baseBranch: 'main',
			url: 'https://github.com/test/repo/pull/123',
			isDraft: false,
		}

		vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockOpenPR)
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: true,
			unstagedFiles: ['file1.ts'],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123, dryRun: true },
		})

		// Verify operations were NOT executed (only logged)
		expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()

		expect(pushBranchToRemote).not.toHaveBeenCalled()

		expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
	})

	it('should log cleanup without executing for closed PR dry-run', async () => {
		const mockClosedPR: PullRequest = {
			number: 123,
			title: 'Test PR',
			body: 'Test body',
			state: 'closed',
			branch: 'feat-pr-123',
			baseBranch: 'main',
			url: 'https://github.com/test/repo/pull/123',
			isDraft: false,
		}

		vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockClosedPR)
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'feat-pr-123',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		await finishCommand.execute({
			identifier: undefined,
			options: { pr: 123, dryRun: true },
		})

		// Verify cleanup was called with dryRun: true
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				dryRun: true,
			})
		)
	})
})

describe('FinishCommand - Issue Workflow (Regression Tests)', () => {
	let finishCommand: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup

	const mockWorktree: GitWorktree = {
		path: '/test/worktree/feat-issue-45',
		branch: 'feat-issue-45',
		commit: 'abc123',
		bare: false,
		detached: false,
		locked: false,
	}

	const mockIssue: Issue = {
		number: 45,
		title: 'Test Issue',
		body: 'Test body',
		state: 'open',
		url: 'https://github.com/test/repo/issues/45',
		labels: [],
		assignees: [],
	}

	beforeEach(() => {
		// Create mocks
		mockGitHubService = {
			fetchPR: vi.fn(),
			fetchIssue: vi.fn().mockResolvedValue(mockIssue),
			supportsPullRequests: true,
			providerName: 'github',
		} as unknown as GitHubService

		mockGitWorktreeManager = {
			findWorktreeForPR: vi.fn(),
			findWorktreeForIssue: vi.fn().mockResolvedValue(mockWorktree),
			findWorktreeForBranch: vi.fn(),
		} as unknown as GitWorktreeManager

		mockValidationRunner = {
			runValidations: vi.fn().mockResolvedValue(undefined),
		} as unknown as ValidationRunner

		mockCommitManager = {
			detectUncommittedChanges: vi.fn().mockResolvedValue({
				hasUncommittedChanges: false,
				unstagedFiles: [],
				stagedFiles: [],
				currentBranch: 'feat-issue-45',
				isAheadOfRemote: false,
				isBehindRemote: false,
			}),
			commitChanges: vi.fn().mockResolvedValue(undefined),
		} as unknown as CommitManager

		mockMergeManager = {
			rebaseOnMain: vi.fn().mockResolvedValue(undefined),
			performFastForwardMerge: vi.fn().mockResolvedValue(undefined),
		} as unknown as MergeManager

		mockIdentifierParser = {
			parseForPatternDetection: vi.fn().mockResolvedValue({
				type: 'issue',
				number: 45,
				originalInput: '45',
			}),
		} as unknown as IdentifierParser

		mockResourceCleanup = {
			cleanupWorktree: vi.fn().mockResolvedValue({
				identifier: '45',
				success: true,
				operations: [],
				errors: [],
				rollbackRequired: false,
			}),
		} as unknown as ResourceCleanup

		const mockBuildRunner = {
			runBuild: vi.fn().mockResolvedValue({
				success: true,
				skipped: true,
				reason: 'Not a CLI project',
				duration: 0,
			}),
		} as unknown as BuildRunner

		// Create command with mocked dependencies
		finishCommand = new FinishCommand(
			mockGitHubService,
			mockGitWorktreeManager,
			mockValidationRunner,
			mockCommitManager,
			mockMergeManager,
			mockIdentifierParser,
			mockResourceCleanup,
			mockBuildRunner
		)
	})

	it('should still execute issue workflow for issues', async () => {
		await finishCommand.execute({
			identifier: '45',
			options: {},
		})

		// Verify full issue workflow was executed
		expect(mockValidationRunner.runValidations).toHaveBeenCalled()
		expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
		expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalled()
		expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()

		// Verify PR workflow was NOT used
		expect(pushBranchToRemote).not.toHaveBeenCalled()
	})
})

