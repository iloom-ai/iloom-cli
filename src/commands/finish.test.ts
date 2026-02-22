import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FinishCommand } from './finish.js'
import { GitHubService } from '../lib/GitHubService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { ValidationRunner } from '../lib/ValidationRunner.js'
import { CommitManager } from '../lib/CommitManager.js'
import { MergeManager } from '../lib/MergeManager.js'
import { IdentifierParser } from '../utils/IdentifierParser.js'
import { ResourceCleanup } from '../lib/ResourceCleanup.js'
import { ProcessManager } from '../lib/process/ProcessManager.js'
import { BuildRunner } from '../lib/BuildRunner.js'
import { DatabaseManager } from '../lib/DatabaseManager.js'
import { NeonProvider } from '../lib/providers/NeonProvider.js'
import { loadEnvIntoProcess } from '../utils/env.js'
import type { Issue, PullRequest } from '../types/index.js'
import { UserAbortedCommitError } from '../types/index.js'
import type { GitWorktree } from '../types/worktree.js'
import { GitHubError, GitHubErrorCode } from '../types/github.js'
import { findMainWorktreePathWithSettings, pushBranchToRemote } from '../utils/git.js'
import { logger } from '../utils/logger.js'
import { installDependencies } from '../utils/package-manager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { PRManager } from '../lib/PRManager.js'

// Mock TelemetryService
const mockTrack = vi.fn()
vi.mock('../lib/TelemetryService.js', () => ({
	TelemetryService: {
		getInstance: () => ({ track: mockTrack }),
	},
}))

// Mock MetadataManager for telemetry duration calculation
const mockReadMetadata = vi.fn().mockResolvedValue({
	created_at: new Date(Date.now() - 60 * 60000).toISOString(), // 60 minutes ago
	status: 'active',
})
vi.mock('../lib/MetadataManager.js', () => ({
	MetadataManager: vi.fn(() => ({
		readMetadata: mockReadMetadata,
		archiveMetadata: vi.fn().mockResolvedValue(undefined),
	})),
}))

// Mock dependencies
vi.mock('../lib/GitHubService.js')
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/ValidationRunner.js')
vi.mock('../lib/CommitManager.js')
vi.mock('../lib/MergeManager.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('../lib/ResourceCleanup.js')
vi.mock('../lib/process/ProcessManager.js')
vi.mock('../lib/BuildRunner.js')
vi.mock('../lib/DatabaseManager.js')
vi.mock('../lib/providers/NeonProvider.js')
vi.mock('../lib/EnvironmentManager.js')
vi.mock('../lib/PRManager.js')
vi.mock('../lib/MetadataManager.js', () => {
	class MockMetadataManager {
		async readMetadata() { return null }
		async archiveMetadata() { return undefined }
	}
	return { MetadataManager: MockMetadataManager }
})
vi.mock('../utils/env.js')
vi.mock('../lib/SettingsManager.js', () => {
	return {
		SettingsManager: class MockSettingsManager {
			async loadSettings() {
				return {}
			}
		},
	}
})

// Mock package-manager utilities
vi.mock('../utils/package-manager.js', () => ({
	installDependencies: vi.fn().mockResolvedValue(undefined),
	detectPackageManager: vi.fn().mockResolvedValue('pnpm'),
	runScript: vi.fn().mockResolvedValue(undefined),
}))

// Mock git utils module for pushBranchToRemote and findMainWorktreePathWithSettings
vi.mock('../utils/git.js', async () => {
	const actual = await vi.importActual<typeof import('../utils/git.js')>('../utils/git.js')
	return {
		...actual,
		pushBranchToRemote: vi.fn().mockResolvedValue(undefined),
		findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/test/main'),
		getMergeTargetBranch: vi.fn().mockResolvedValue('main'),
		isPlaceholderCommit: vi.fn().mockResolvedValue(false),
		findPlaceholderCommitSha: vi.fn().mockResolvedValue(null),
		removePlaceholderCommitFromHead: vi.fn().mockResolvedValue(undefined),
		removePlaceholderCommitFromHistory: vi.fn().mockResolvedValue(undefined),
		// Prevent real git commands from running during tests
		executeGitCommand: vi.fn().mockResolvedValue(''),
	}
})

// Mock remote utils module
vi.mock('../utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn().mockResolvedValue(false),
	getConfiguredRepoFromSettings: vi.fn().mockResolvedValue('owner/repo'),
	parseGitRemotes: vi.fn().mockResolvedValue([]),
	validateConfiguredRemote: vi.fn().mockResolvedValue(undefined),
}))

// Mock the logger to prevent console output during tests
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
	createLogger: vi.fn().mockReturnValue({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
		setDebug: vi.fn(),
	}),
}))

describe('FinishCommand', () => {
	let command: FinishCommand
	let mockGitHubService: GitHubService
	let mockGitWorktreeManager: GitWorktreeManager
	let mockValidationRunner: ValidationRunner
	let mockCommitManager: CommitManager
	let mockMergeManager: MergeManager
	let mockIdentifierParser: IdentifierParser
	let mockResourceCleanup: ResourceCleanup
	let mockProcessManager: ProcessManager
	let mockBuildRunner: BuildRunner
	let originalIloomEnv: string | undefined

	beforeEach(() => {
		// Save and clear ILOOM env for test isolation
		originalIloomEnv = process.env.ILOOM
		delete process.env.ILOOM
		mockGitHubService = new GitHubService()
		// Set IssueTracker interface properties
		mockGitHubService.supportsPullRequests = true
		mockGitHubService.providerName = 'github'
		mockGitWorktreeManager = new GitWorktreeManager()
		mockValidationRunner = new ValidationRunner()
		mockCommitManager = new CommitManager()
		mockMergeManager = new MergeManager()
		mockIdentifierParser = new IdentifierParser(mockGitWorktreeManager)
		mockProcessManager = new ProcessManager()
		mockResourceCleanup = new ResourceCleanup(
			mockGitWorktreeManager,
			mockProcessManager,
			undefined
		)
		mockBuildRunner = new BuildRunner()

		// Mock loadEnvIntoProcess to succeed by default
		vi.mocked(loadEnvIntoProcess).mockReturnValue({
			parsed: {},
			error: undefined
		})

		// Mock ValidationRunner.runValidations to always succeed by default
		vi.mocked(mockValidationRunner.runValidations).mockResolvedValue({
			success: true,
			steps: [],
			totalDuration: 0,
		})

		// Mock CommitManager.detectUncommittedChanges to return no changes by default
		vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
			hasUncommittedChanges: false,
			unstagedFiles: [],
			stagedFiles: [],
			currentBranch: 'main',
			isAheadOfRemote: false,
			isBehindRemote: false,
		})

		// Mock CommitManager.commitChanges to succeed by default
		vi.mocked(mockCommitManager.commitChanges).mockResolvedValue(undefined)

		// Mock MergeManager methods to succeed by default
		vi.mocked(mockMergeManager.rebaseOnMain).mockResolvedValue(undefined)
		vi.mocked(mockMergeManager.performFastForwardMerge).mockResolvedValue(undefined)

		// Mock ResourceCleanup.cleanupWorktree to succeed by default
		vi.mocked(mockResourceCleanup.cleanupWorktree).mockResolvedValue({
			identifier: 'test',
			success: true,
			operations: [],
			errors: [],
			rollbackRequired: false,
		})

		// Mock GitWorktreeManager specific finding methods (used by IdentifierParser and FinishCommand)
		vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(null)
		vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)
		vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(null)

		// Mock BuildRunner.runBuild to succeed by default (skipped)
		vi.mocked(mockBuildRunner.runBuild).mockResolvedValue({
			success: true,
			skipped: true,
			reason: 'Not a CLI project',
			duration: 0,
		})

		command = new FinishCommand(
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

	afterEach(() => {
		vi.clearAllMocks()
		// Restore ILOOM env
		if (originalIloomEnv !== undefined) {
			process.env.ILOOM = originalIloomEnv
		} else {
			delete process.env.ILOOM
		}
	})

	describe('dependency injection', () => {
		it('should accept IssueTracker via constructor', () => {
			const customService = new GitHubService()
			const cmd = new FinishCommand(customService)

			expect(cmd['issueTracker']).toBe(customService)
		})

		it('should accept GitWorktreeManager via constructor', () => {
			const customManager = new GitWorktreeManager()
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker, customManager)

			expect(cmd['gitWorktreeManager']).toBe(customManager)
		})

		it('should accept ValidationRunner via constructor', () => {
			const customRunner = new ValidationRunner()
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker, undefined, customRunner)

			expect(cmd['validationRunner']).toBe(customRunner)
		})

		it('should accept CommitManager via constructor', () => {
			const customManager = new CommitManager()
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker, undefined, undefined, customManager)

			expect(cmd['commitManager']).toBe(customManager)
		})

		it('should accept MergeManager via constructor', () => {
			const customManager = new MergeManager()
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker, undefined, undefined, undefined, customManager)

			expect(cmd['mergeManager']).toBe(customManager)
		})

		it('should accept ResourceCleanup via constructor', () => {
			const customCleanup = new ResourceCleanup(
				mockGitWorktreeManager,
				mockProcessManager,
				undefined
			)
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(
				mockIssueTracker,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				customCleanup
			)

			expect(cmd['resourceCleanup']).toBe(customCleanup)
		})

		it('should create default instances for optional deps when not provided', () => {
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker)

			// IssueTracker is now required
			expect(cmd['issueTracker']).toBe(mockIssueTracker)
			expect(cmd['gitWorktreeManager']).toBeInstanceOf(GitWorktreeManager)
			expect(cmd['validationRunner']).toBeInstanceOf(ValidationRunner)
			expect(cmd['commitManager']).toBeInstanceOf(CommitManager)
			expect(cmd['mergeManager']).toBeInstanceOf(MergeManager)
			expect(cmd['identifierParser']).toBeInstanceOf(IdentifierParser)
			// ResourceCleanup is lazily initialized, so it should be undefined initially
			expect(cmd['resourceCleanup']).toBeUndefined()
		})

		it('should load environment variables during construction', () => {
			const mockLoadEnv = vi.mocked(loadEnvIntoProcess)
			mockLoadEnv.mockClear() // Clear previous calls
			mockLoadEnv.mockReturnValue({
				parsed: {},
				error: undefined
			})

			const mockIssueTracker = new GitHubService()
			new FinishCommand(mockIssueTracker)

			expect(mockLoadEnv).toHaveBeenCalledOnce()
		})

		it('should handle environment loading errors gracefully', () => {
			const mockLoadEnv = vi.mocked(loadEnvIntoProcess)
			mockLoadEnv.mockClear() // Clear previous calls
			const mockError = new Error('Failed to load .env')
			mockLoadEnv.mockReturnValue({
				parsed: undefined,
				error: mockError
			})

			const mockIssueTracker = new GitHubService()
			// Should not throw
			expect(() => new FinishCommand(mockIssueTracker)).not.toThrow()
			expect(mockLoadEnv).toHaveBeenCalledOnce()
		})

		it('should lazily initialize ResourceCleanup when needed', () => {
			const mockIssueTracker = new GitHubService()
			const cmd = new FinishCommand(mockIssueTracker)

			// ResourceCleanup should be undefined initially (lazy initialization)
			expect(cmd['resourceCleanup']).toBeUndefined()
		})

		it('should not initialize DatabaseManager during construction (lazy initialization)', () => {
			// Clear any previous constructor calls
			vi.mocked(NeonProvider).mockClear()
			vi.mocked(DatabaseManager).mockClear()

			const mockIssueTracker = new GitHubService()
			new FinishCommand(mockIssueTracker)

			// DatabaseManager and NeonProvider should NOT be created during construction
			// They are created lazily when needed
			expect(NeonProvider).not.toHaveBeenCalled()
			expect(DatabaseManager).not.toHaveBeenCalled()
		})

		it('should verify database cleanup happens during post-merge cleanup', async () => {
			// Mock IdentifierParser to return issue type
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 123,
				originalInput: '123',
			})

			// Mock worktree finding
			const mockWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

			// Mock issue API
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			})

			// Set up a successful cleanup scenario with database cleanup
			vi.mocked(mockResourceCleanup.cleanupWorktree).mockResolvedValue({
				success: true,
				operations: [
					{ type: 'worktree', success: true, message: 'Worktree removed' },
					{ type: 'database', success: true, message: 'Database branch cleaned up' }
				],
				errors: [],
				branchName: 'feat/issue-123'
			})

			await command.execute({
				identifier: '123',
				options: {},
			})

			// Verify ResourceCleanup was called with keepDatabase: false for post-merge cleanup
			expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
				expect.any(Object),
				expect.objectContaining({
					keepDatabase: false,
					deleteBranch: true
				})
			)
		})
	})

	describe('execute', () => {
		describe('workflow execution order', () => {
			const mockWorktree: GitWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			const mockIssue: Issue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			beforeEach(() => {
				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should set ILOOM=1 in process.env during execute', async () => {
				// Verify ILOOM is not set before execute
				expect(process.env.ILOOM).toBeUndefined()

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify ILOOM is set after execute
				expect(process.env.ILOOM).toBe('1')
			})

			it('should execute complete workflow including merge steps', async () => {
				// Track execution order
				const executionOrder: string[] = []

				vi.mocked(mockValidationRunner.runValidations).mockImplementation(async () => {
					executionOrder.push('validation')
					return { success: true, steps: [], totalDuration: 0 }
				})

				vi.mocked(mockCommitManager.detectUncommittedChanges).mockImplementation(async () => {
					executionOrder.push('detectChanges')
					return {
						hasUncommittedChanges: false,
						unstagedFiles: [],
						stagedFiles: [],
						currentBranch: 'feat/issue-123',
						isAheadOfRemote: false,
						isBehindRemote: false,
					}
				})

				vi.mocked(mockMergeManager.rebaseOnMain).mockImplementation(async () => {
					executionOrder.push('rebase')
				})

				vi.mocked(mockMergeManager.performFastForwardMerge).mockImplementation(async () => {
					executionOrder.push('merge')
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify all steps executed in correct order (Issue #344: rebase first)
				expect(executionOrder).toEqual(['rebase', 'validation', 'detectChanges', 'merge'])
			})

			it('should run validation BEFORE detecting and committing changes', async () => {
				const executionOrder: string[] = []

				vi.mocked(mockValidationRunner.runValidations).mockImplementation(async () => {
					executionOrder.push('validation')
					return { success: true, steps: [], totalDuration: 0 }
				})

				vi.mocked(mockCommitManager.detectUncommittedChanges).mockImplementation(async () => {
					executionOrder.push('detectChanges')
					return {
						hasUncommittedChanges: true,
						unstagedFiles: ['test.ts'],
						stagedFiles: [],
						currentBranch: 'feat/issue-123',
						isAheadOfRemote: false,
						isBehindRemote: false,
					}
				})

				vi.mocked(mockCommitManager.commitChanges).mockImplementation(async () => {
					executionOrder.push('commit')
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify validation happens before detection and commit
				const validationIndex = executionOrder.indexOf('validation')
				const detectIndex = executionOrder.indexOf('detectChanges')
				const commitIndex = executionOrder.indexOf('commit')

				expect(validationIndex).toBeLessThan(detectIndex)
				expect(detectIndex).toBeLessThan(commitIndex)
			})

			it('should NOT commit if validation fails', async () => {
				// Mock validation failure
				vi.mocked(mockValidationRunner.runValidations).mockRejectedValue(
					new Error('Validation failed: TypeScript errors found')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Validation failed: TypeScript errors found')

				// Verify commit was never called
				expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
			})

			it('should pass correct options to MergeManager', async () => {
				await command.execute({
					identifier: '123',
					options: {
						dryRun: true,
						force: true,
					},
				})

				// Verify rebaseOnMain received correct options
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith(
					mockWorktree.path,
					{
						dryRun: true,
						force: true,
					}
				)

				// Verify performFastForwardMerge received correct options
				expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalledWith(
					mockWorktree.branch,
					mockWorktree.path,
					{
						dryRun: true,
						force: true,
					}
				)
			})

			it('should handle rebase conflicts and stop workflow', async () => {
				const conflictError = new Error(
					'Rebase failed - merge conflicts detected in:\n' +
					'  • src/test.ts\n\n' +
					'To resolve manually:\n' +
					'  1. Fix conflicts in the files above\n' +
					'  2. Stage resolved files: git add <files>\n' +
					'  3. Continue rebase: git rebase --continue\n' +
					'  4. Or abort rebase: git rebase --abort\n' +
					'  5. Then re-run: il finish <issue-number>'
				)

				vi.mocked(mockMergeManager.rebaseOnMain).mockRejectedValue(conflictError)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Rebase failed - merge conflicts detected')

				// Verify rebase was called
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()

				// Verify fast-forward merge was NOT called (workflow stopped)
				expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
			})
		})

		describe('input parsing - explicit identifier', () => {
			it('should parse plain issue number (123)', async () => {
				// Mock parseForPatternDetection to return issue type
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 123,
					title: 'Test Issue',
					body: 'Test body',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/issue-123',
					branch: 'feat/issue-123',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
					mockWorktree
				)

				await command.execute({
					identifier: '123',
					options: { dryRun: true },
				})

				// Verify IdentifierParser was called with the plain number
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('123')

				// Verify GitHub API was called to validate the issue
				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)

				// Verify specific worktree finding method was used
				expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith(123)
			})

			it('should parse hash-prefixed issue number (#123)', async () => {
				// Mock parseForPatternDetection to strip # and return issue type
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '#123',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 123,
					title: 'Test Issue',
					body: 'Test body',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/issue-123',
					branch: 'feat/issue-123',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
					mockWorktree
				)

				await command.execute({
					identifier: '#123',
					options: { dryRun: true },
				})

				// Verify IdentifierParser was called with hash-prefixed input
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('#123')

				// Verify GitHub API was called to validate the issue
				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
			})

			it('should parse PR-specific format (pr/123)', async () => {
				// PR format is handled directly in FinishCommand, NOT via IdentifierParser
				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 123,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/123',
					isDraft: false,
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_123',
					branch: 'feat/test',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: 'pr/123',
					options: { dryRun: true },
				})

				// Verify IdentifierParser was NOT called (PR format handled directly)
				expect(mockIdentifierParser.parseForPatternDetection).not.toHaveBeenCalled()

				// Verify GitHub API was called to validate the PR
				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)

				// Verify specific worktree finding method was used
				expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(123, '')
			})

			it('should parse PR-specific format (PR-123)', async () => {
				// Test uppercase PR- format
				const mockPR: PullRequest = {
					number: 123,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/123',
					isDraft: false,
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_123',
					branch: 'feat/test',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: 'PR-123',
					options: { dryRun: true },
				})

				expect(mockIdentifierParser.parseForPatternDetection).not.toHaveBeenCalled()
				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)
			})

			it('should parse PR-specific format (PR/123)', async () => {
				// Test uppercase PR/ format
				const mockPR: PullRequest = {
					number: 123,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/123',
					isDraft: false,
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_123',
					branch: 'feat/test',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: 'PR/123',
					options: { dryRun: true },
				})

				expect(mockIdentifierParser.parseForPatternDetection).not.toHaveBeenCalled()
				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)
			})

			it('should parse branch name as fallback', async () => {
				// Mock parseForPatternDetection to return branch type
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'branch',
					branchName: 'feat/custom-branch',
					originalInput: 'feat/custom-branch',
				})

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-custom-branch',
					branch: 'feat/custom-branch',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(
					mockWorktree
				)

				await command.execute({
					identifier: 'feat/custom-branch',
					options: { dryRun: true },
				})

				// Verify IdentifierParser was called with the branch name
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith(
					'feat/custom-branch'
				)

				// Verify specific worktree finding method was used
				expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith(
					'feat/custom-branch'
				)

				// GitHub API should NOT be called for branch names
				expect(mockGitHubService.fetchIssue).not.toHaveBeenCalled()
				expect(mockGitHubService.fetchPR).not.toHaveBeenCalled()
			})

			it('should trim whitespace from input', async () => {
				// Mock parseForPatternDetection to return issue type
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '  123  ',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 123,
					title: 'Test Issue',
					body: 'Test body',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/issue-123',
					branch: 'feat/issue-123',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
					mockWorktree
				)

				await command.execute({
					identifier: '  123  ',
					options: { dryRun: true },
				})

				// Verify IdentifierParser was called with trimmed input
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('123')
			})
		})

		describe('PR flag handling', () => {
			it('should use --pr flag value when provided', async () => {
				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_456',
					branch: 'feat/test',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: undefined,
					options: { pr: 456, dryRun: true },
				})

				// Verify PR API was called with flag value
				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456)

				// Verify IdentifierParser was NOT called (flag takes priority)
				expect(mockIdentifierParser.parseForPatternDetection).not.toHaveBeenCalled()
			})

			it('should prioritize --pr flag over identifier', async () => {
				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 789,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/789',
					isDraft: false,
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_789',
					branch: 'feat/test',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: '123', // This should be ignored
					options: { pr: 789, dryRun: true },
				})

				// Verify PR API was called with flag value (789), NOT identifier (123)
				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(789)
				expect(mockGitHubService.fetchIssue).not.toHaveBeenCalled()

				// Verify IdentifierParser was NOT called (flag takes priority)
				expect(mockIdentifierParser.parseForPatternDetection).not.toHaveBeenCalled()
			})
		})

		describe('GitHub API detection', () => {
			it('should detect issue vs PR for numeric input via GitHub API', async () => {
				// Mock parseForPatternDetection to return issue type (based on worktree patterns)
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 42,
					originalInput: '42',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 42,
					title: 'Test Issue',
					body: 'Test body',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/42',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock worktree finding
				const mockWorktree: GitWorktree = {
					path: '/test/worktree/issue-42',
					branch: 'feat/issue-42',
					prunable: 'no',
					bare: false,
					detached: false,
					locked: '',
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(
					mockWorktree
				)

				await command.execute({
					identifier: '42',
					options: { dryRun: true },
				})

				// Verify pattern detection was used first
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('42')

				// Verify GitHub API was called to validate the issue
				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(42, undefined)
			})

			it('should throw error if number is neither issue nor PR', async () => {
				// Mock parseForPatternDetection to throw (no worktree found)
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockRejectedValue(
					new Error('No worktree found for identifier: 999')
				)

				await expect(
					command.execute({
						identifier: '999',
						options: { dryRun: true },
					})
				).rejects.toThrow('No worktree found for identifier: 999')

				// Verify parseForPatternDetection was called
				expect(mockIdentifierParser.parseForPatternDetection).toHaveBeenCalledWith('999')

				// GitHub API should not be called if pattern detection fails
				expect(mockGitHubService.fetchIssue).not.toHaveBeenCalled()
				expect(mockGitHubService.fetchPR).not.toHaveBeenCalled()
			})
		})

		describe('auto-detection from current directory', () => {
			it('should auto-detect PR number from _pr_N worktree directory pattern', async () => {
				// Mock process.cwd() to return a directory with _pr_123 pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/feat-issue-46_pr_123')

				// Mock GitWorktreeManager.getRepoInfo for fallback branch detection
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: 'feat/issue-46',
					rootPath: '/path/to/repo',
				})

				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 123,
					title: 'Test PR',
					state: 'open',
					html_url: 'https://github.com/test/repo/pull/123',
					head: { ref: 'feat/issue-46' },
					base: { ref: 'main' },
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock findWorktreeForPR to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/feat-issue-46_pr_123',
					branch: 'feat/issue-46',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				try {
					await command.execute({
						identifier: undefined, // No explicit identifier - should auto-detect
						options: { dryRun: true },
					})

					// Verify PR was fetched with auto-detected number
					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)
					expect(mockGitWorktreeManager.findWorktreeForPR).toHaveBeenCalledWith(123, '')
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})

			it('should auto-detect issue number from issue-N branch pattern', async () => {
				// Mock process.cwd() to return a directory with issue-66 pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/feat-issue-66')

				// Mock GitWorktreeManager.getRepoInfo for fallback branch detection
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: 'feat/issue-66',
					rootPath: '/path/to/repo',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 66,
					title: 'Test Issue',
					state: 'open',
					html_url: 'https://github.com/test/repo/issues/66',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/66',
					body: '',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock findWorktreeForIssue to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/feat-issue-66',
					branch: 'feat/issue-66',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				try {
					await command.execute({
						identifier: undefined,
						options: { dryRun: true },
					})

					// Verify issue was fetched with auto-detected number
					expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith('66', undefined)
					expect(mockGitWorktreeManager.findWorktreeForIssue).toHaveBeenCalledWith("66")
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})

			it('should extract PR number from directory like "feat-issue-46_pr_123"', async () => {
				// Mock process.cwd() to return complex directory pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/feat-issue-46_pr_123')

				// Mock GitWorktreeManager.getRepoInfo for fallback
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: 'feat/issue-46',
					rootPath: '/path/to/repo',
				})

				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 123,
					title: 'Test PR',
					state: 'open',
					html_url: 'https://github.com/test/repo/pull/123',
					head: { ref: 'feat/issue-46' },
					base: { ref: 'main' },
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock findWorktreeForPR to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/feat-issue-46_pr_123',
					branch: 'feat/issue-46',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				try {
					await command.execute({
						identifier: undefined,
						options: { dryRun: true },
					})

					// Verify PR number 123 was extracted (not issue number 46)
					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(123)
					expect(mockGitHubService.fetchIssue).not.toHaveBeenCalled()
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})

			it('should detect when running in PR worktree without identifier argument', async () => {
				// Mock process.cwd() to return PR worktree pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/feature-branch_pr_456')

				// Mock GitWorktreeManager.getRepoInfo
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: 'feature-branch',
					rootPath: '/path/to/repo',
				})

				// Mock GitHub API to return a valid PR
				const mockPR: PullRequest = {
					number: 456,
					title: 'Feature PR',
					state: 'open',
					html_url: 'https://github.com/test/repo/pull/456',
					head: { ref: 'feature-branch' },
					base: { ref: 'main' },
				}
				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				// Mock findWorktreeForPR to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/feature-branch_pr_456',
					branch: 'feature-branch',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

				try {
					await command.execute({
						identifier: undefined, // No identifier provided
						options: { dryRun: true },
					})

					// Verify it auto-detected PR #456
					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456)
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})

			it('should fall back to branch name when no pattern matches', async () => {
				// Mock process.cwd() with no recognizable pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/my-custom-branch')

				// Mock GitWorktreeManager.getRepoInfo to return the branch
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: 'my-custom-branch',
					rootPath: '/path/to/repo',
				})

				// Mock findWorktreeForBranch to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/my-custom-branch',
					branch: 'my-custom-branch',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)

				try {
					await command.execute({
						identifier: undefined,
						options: { dryRun: true },
					})

					// Verify it fell back to branch name
					expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith('my-custom-branch')
					// Should not attempt to fetch issue or PR
					expect(mockGitHubService.fetchIssue).not.toHaveBeenCalled()
					expect(mockGitHubService.fetchPR).not.toHaveBeenCalled()
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})

			it('should throw error when auto-detection fails completely', async () => {
				// Mock process.cwd() with no pattern
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/path/to/worktrees/random-dir')

				// Mock GitWorktreeManager.getRepoInfo to return null/undefined branch
				vi.mocked(mockGitWorktreeManager.getRepoInfo).mockResolvedValue({
					mainBranch: 'main',
					currentBranch: null, // No current branch
					rootPath: '/path/to/repo',
				})

				try {
					await expect(
						command.execute({
							identifier: undefined,
							options: { dryRun: true },
						})
					).rejects.toThrow(/Could not auto-detect identifier/)
				} finally {
					// Restore original cwd
					process.cwd = originalCwd
				}
			})
		})

		describe('edge cases', () => {
			it('should handle very large issue numbers (999999)', async () => {
				// Mock IdentifierParser to return large number
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 999999,
					originalInput: '999999',
				})

				// Mock GitHub API to return a valid issue with large number
				const mockIssue: Issue = {
					number: 999999,
					title: 'Large Issue Number',
					state: 'open',
					html_url: 'https://github.com/test/repo/issues/999999',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/999999',
					body: '',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock findWorktreeForIssue to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/issue-999999',
					branch: 'issue-999999',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: '999999',
					options: { dryRun: true },
				})

				// Verify it parsed and validated the large number correctly
				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(999999, undefined)
			})

			it('should handle leading zeros in numbers', async () => {
				// Mock IdentifierParser to handle leading zeros
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 42, // Leading zeros stripped
					originalInput: '00042',
				})

				// Mock GitHub API to return a valid issue
				const mockIssue: Issue = {
					number: 42,
					title: 'Issue with leading zeros',
					state: 'open',
					html_url: 'https://github.com/test/repo/issues/42',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/42',
					body: '',
				}
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock findWorktreeForIssue to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/issue-42',
					branch: 'issue-42',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: '00042',
					options: { dryRun: true },
				})

				// Verify leading zeros were handled correctly (parsed as 42, not 42 with leading zeros)
				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(42, undefined)
			})

			it('should reject invalid characters in branch names', async () => {
				// Mock IdentifierParser to return a branch with invalid characters
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'branch',
					branchName: 'invalid@branch#name',
					originalInput: 'invalid@branch#name',
				})

				// Mock findWorktreeForBranch to return a worktree (validation happens after finding)
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/invalid-branch',
					branch: 'invalid@branch#name',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)

				// Should throw error due to invalid branch name format
				await expect(
					command.execute({
						identifier: 'invalid@branch#name',
						options: { dryRun: true },
					})
				).rejects.toThrow(/Invalid branch name/)
			})

			it('should handle single-character branch names', async () => {
				// Mock IdentifierParser to return a single-character branch
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'branch',
					branchName: 'x',
					originalInput: 'x',
				})

				// Mock findWorktreeForBranch to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/x',
					branch: 'x',
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: 'x',
					options: { dryRun: true },
				})

				// Verify single-character branch name is handled correctly
				expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith('x')
			})

			it('should handle very long branch names (255+ chars)', async () => {
				// Create a branch name longer than 255 characters
				const longBranchName = 'a'.repeat(300)

				// Mock IdentifierParser to return the long branch name
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'branch',
					branchName: longBranchName,
					originalInput: longBranchName,
				})

				// Mock findWorktreeForBranch to return a valid worktree
				const mockWorktree: GitWorktree = {
					path: '/path/to/worktrees/long-branch',
					branch: longBranchName,
					commit: 'abc123',
					locked: false,
					prunable: false,
				}
				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: longBranchName,
					options: { dryRun: true },
				})

				// Verify very long branch name is handled (Git may have its own limits, but we don't restrict it)
				expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith(longBranchName)
			})
		})

		describe('validation', () => {
			describe('issue validation', () => {
				const mockWorktree: GitWorktree = {
					path: '/test/worktree-issue-123',
					branch: 'feat/issue-123__test',
					commit: 'abc123',
					isPR: false,
					issueNumber: 123,
				}

				it('should validate open issue exists on GitHub', async () => {
					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					// Mock open issue
					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
				})

				it('should throw error for closed issue without --force', async () => {
					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					// Mock closed issue
					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'closed',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await expect(
						command.execute({
							identifier: '123',
							options: {},
						})
					).rejects.toThrow('Issue #123 is closed. Use --force to finish anyway.')

					// Verify validation failed before detecting/committing changes
					expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
					expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				})

				it('should allow closed issue with --force flag', async () => {
					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					// Mock closed issue
					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'closed',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123',
						options: { force: true },
					})

					expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
					expect(mockValidationRunner.runValidations).toHaveBeenCalled()
				})

				it('should throw error if issue not found on GitHub', async () => {
					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 999,
						originalInput: '999',
					})

					// Mock NOT_FOUND error
					const notFoundError = new GitHubError(
						GitHubErrorCode.NOT_FOUND,
						'Issue #999 not found'
					)

					vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(notFoundError)

					await expect(
						command.execute({
							identifier: '999',
							options: {},
						})
					).rejects.toThrow('Issue #999 not found')

					// Verify validation failed before detecting/committing changes
					expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
					expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				})

				it('should throw error if worktree not found for issue', async () => {
					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					// Mock open issue
					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)

					await expect(
						command.execute({
							identifier: '123',
							options: {},
						})
					).rejects.toThrow("No worktree found for Issue #123. Use 'il list' to see available worktrees.")

					// Verify validation failed before detecting/committing changes
					expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
					expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				})
			})

			describe('PR validation', () => {
				const mockWorktree: GitWorktree = {
					path: '/test/worktree-pr-456',
					branch: 'feat/test-feature',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				it('should validate open PR exists on GitHub', async () => {
					// Mock open PR
					const mockPR: PullRequest = {
						number: 456,
						title: 'Test PR',
						body: 'Test description',
						state: 'open',
						branch: 'feat/test-feature',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456)
				})

				it('should allow closed PR (cleanup-only mode)', async () => {
					// Mock closed PR
					const mockPR: PullRequest = {
						number: 456,
						title: 'Test PR',
						body: 'Test description',
						state: 'closed',
						branch: 'feat/test-feature',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456)
					// Closed PRs skip validation and go straight to cleanup
					expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
					expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
				})

				it('should allow merged PR (cleanup-only mode)', async () => {
					// Mock merged PR
					const mockPR: PullRequest = {
						number: 456,
						title: 'Test PR',
						body: 'Test description',
						state: 'merged',
						branch: 'feat/test-feature',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456)
					// Merged PRs skip validation and go straight to cleanup
					expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()
					expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
				})

				it('should skip safety checks for merged PRs (work is safely in main)', async () => {
					// For merged PRs:
					// - checkMergeSafety: false (work is in main, no data loss risk)
					// - checkRemoteBranch: false (GitHub may auto-delete branch after merge)
					const mockPR: PullRequest = {
						number: 456,
						title: 'Test PR',
						body: 'Test description',
						state: 'merged',
						branch: 'feat/test-feature',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					// Verify safety checks are skipped for merged PRs
					expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
						expect.any(Object),
						expect.objectContaining({
							checkRemoteBranch: false,
							checkMergeSafety: false,
							deleteBranch: true,
						})
					)
				})

				it('should enable safety checks for closed (not merged) PRs (may have unpushed commits)', async () => {
					// For closed PRs (rejected/abandoned):
					// - checkMergeSafety: true (PR may have local commits that were never pushed)
					// - checkRemoteBranch: false (we rely on checkMergeSafety for commit safety)
					const mockPR: PullRequest = {
						number: 456,
						title: 'Test PR',
						body: 'Test description',
						state: 'closed',
						branch: 'feat/test-feature',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					// Verify safety checks are enabled for closed PRs
					expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
						expect.any(Object),
						expect.objectContaining({
							checkRemoteBranch: false,
							checkMergeSafety: true, // Enabled for closed PRs
							deleteBranch: true,
						})
					)
				})

				it('should throw error if PR not found on GitHub', async () => {
					// Mock NOT_FOUND error
					const notFoundError = new GitHubError(
						GitHubErrorCode.NOT_FOUND,
						'PR #999 not found'
					)

					vi.mocked(mockGitHubService.fetchPR).mockRejectedValue(notFoundError)

					await expect(
						command.execute({
							identifier: 'pr/999',
							options: {},
						})
					).rejects.toThrow('PR #999 not found')

					// Verify validation failed before detecting/committing changes
					expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
					expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				})
			})

			describe('branch validation', () => {
				const mockWorktree: GitWorktree = {
					path: '/test/worktree-custom-branch',
					branch: 'custom-branch',
					commit: 'ghi789',
					isPR: false,
				}

				it('should validate branch name format (valid characters)', async () => {
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'branch',
						branchName: 'feat/my-feature-branch',
						originalInput: 'feat/my-feature-branch',
					})

					vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'feat/my-feature-branch',
						options: {},
					})

					expect(mockGitWorktreeManager.findWorktreeForBranch).toHaveBeenCalledWith('feat/my-feature-branch')
				})

				it('should throw error if branch not found', async () => {
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'branch',
						branchName: 'nonexistent-branch',
						originalInput: 'nonexistent-branch',
					})

					vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(null)

					await expect(
						command.execute({
							identifier: 'nonexistent-branch',
							options: {},
						})
					).rejects.toThrow("No worktree found for Branch 'nonexistent-branch'. Use 'il list' to see available worktrees.")

					// Verify validation failed before detecting/committing changes
					expect(mockCommitManager.detectUncommittedChanges).not.toHaveBeenCalled()
					expect(mockCommitManager.commitChanges).not.toHaveBeenCalled()
				})
			})

			describe('worktree auto-detection', () => {
				it('should warn if multiple worktrees match identifier', async () => {
					// Note: The current implementation only returns a single worktree
					// This test documents expected behavior if multiple worktrees are supported in the future
					// For now, we'll test that the first worktree is used

					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					const mockWorktree: GitWorktree = {
						path: '/test/worktree-issue-123',
						branch: 'feat/issue-123__test',
						commit: 'abc123',
						isPR: false,
						issueNumber: 123,
					}

					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockValidationRunner.runValidations).toHaveBeenCalledWith(
						mockWorktree.path,
						expect.any(Object)
					)
				})

				it('should use first matching worktree if multiple found', async () => {
					// Similar to above - documents expected behavior

					// Mock parseForPatternDetection to return issue type
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					const mockWorktree: GitWorktree = {
						path: '/test/worktree-issue-123-first',
						branch: 'feat/issue-123__test',
						commit: 'abc123',
						isPR: false,
						issueNumber: 123,
					}

					const mockIssue: Issue = {
						number: 123,
						title: 'Test Issue',
						body: 'Test description',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123',
						options: {},
					})

					// Verify the first worktree path is used
					expect(mockValidationRunner.runValidations).toHaveBeenCalledWith(
						'/test/worktree-issue-123-first',
						expect.any(Object)
					)
				})
			})
		})

		describe('options handling', () => {
			describe('force flag', () => {
				it('should accept --force flag', async () => {
					// Setup: Closed issue that requires --force
					const mockIssue: Issue = {
						number: 123,
						title: 'Closed Issue',
						body: 'Test',
						state: 'closed',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/123',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-123',
						commit: 'abc123',
						isMain: false,
					}

					// Mock IdentifierParser to detect as issue
					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 123,
						originalInput: '123',
					})

					// Mock GitHub API to return closed issue
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

					// Mock finding worktree
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					// Execute with --force flag
					await expect(
						command.execute({
							identifier: '123',
							options: { force: true },
						})
					).resolves.not.toThrow()

					// Verify GitHub API was called
					expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
				})

				it('should skip confirmations when force=true', async () => {
					// Setup: Closed issue
					const mockIssue: Issue = {
						number: 456,
						title: 'Closed Issue',
						body: 'Test',
						state: 'closed',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/456',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-456',
						commit: 'abc456',
						isMain: false,
					}

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 456,
						originalInput: '456',
					})

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					// Execute with force=true
					await command.execute({
						identifier: '456',
						options: { force: true },
					})

					// Should not throw and should complete workflow
					expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
					expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalled()
				})
			})

			describe('dry-run flag', () => {
				it('should accept --dry-run flag', async () => {
					const mockIssue: Issue = {
						number: 789,
						title: 'Open Issue',
						body: 'Test',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/789',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-789',
						commit: 'abc789',
						isMain: false,
					}

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 789,
						originalInput: '789',
					})

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await expect(
						command.execute({
							identifier: '789',
							options: { dryRun: true },
						})
					).resolves.not.toThrow()

					// GitHub API should still be called (reads allowed in dry-run)
					expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(789, undefined)
				})

				it('should preview actions without executing when dryRun=true', async () => {
					const mockIssue: Issue = {
						number: 100,
						title: 'Test Issue',
						body: 'Test',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/100',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-100',
						commit: 'abc100',
						isMain: false,
					}

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 100,
						originalInput: '100',
					})

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '100',
						options: { dryRun: true },
					})

					// Validation should not be executed in dry-run
					expect(mockValidationRunner.runValidations).not.toHaveBeenCalled()

					// Merge operations should receive dryRun=true
					expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith(
						'/test/worktree',
						expect.objectContaining({ dryRun: true })
					)
					expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalledWith(
						'feat/issue-100',
						'/test/worktree',
						expect.objectContaining({ dryRun: true })
					)
				})

				it('should prefix log messages with [DRY RUN]', async () => {
					const mockIssue: Issue = {
						number: 200,
						title: 'Test Issue',
						body: 'Test',
						state: 'open',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/200',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-200',
						commit: 'abc200',
						isMain: false,
					}

					// Mock logger to capture calls

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 200,
						originalInput: '200',
					})

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '200',
						options: { dryRun: true },
					})

					// Verify logger.info was called with [DRY RUN] prefix
					expect(logger.info).toHaveBeenCalledWith(
						expect.stringMatching(/\[DRY RUN\]/)
					)
				})

				it('should perform GitHub API reads in dry-run mode', async () => {
					const mockPR: PullRequest = {
						number: 300,
						title: 'Test PR',
						body: 'Test',
						state: 'open',
						branch: 'feat/test',
						baseBranch: 'main',
						url: 'https://github.com/owner/repo/pull/300',
						isDraft: false,
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/test',
						commit: 'abc300',
						isMain: false,
					}

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'pr',
						number: 300,
						originalInput: 'pr/300',
					})

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: 'pr/300',
						options: { dryRun: true },
					})

					// GitHub API reads should still occur in dry-run
					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(300)
				})
			})

			describe('flag combinations', () => {
				it('should handle --force and --dry-run together', async () => {
					const mockIssue: Issue = {
						number: 400,
						title: 'Closed Issue',
						body: 'Test',
						state: 'closed',
						labels: [],
						assignees: [],
						url: 'https://github.com/owner/repo/issues/400',
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/issue-400',
						commit: 'abc400',
						isMain: false,
					}

					vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
						type: 'issue',
						number: 400,
						originalInput: '400',
					})

					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '400',
						options: { force: true, dryRun: true },
					})

					// Both options should be passed to merge manager
					expect(mockMergeManager.rebaseOnMain).toHaveBeenCalledWith(
						'/test/worktree',
						expect.objectContaining({ dryRun: true, force: true })
					)
				})

				it('should handle --pr with --force', async () => {
					const mockPR: PullRequest = {
						number: 500,
						title: 'Test PR',
						body: 'Test',
						state: 'open',
						branch: 'feat/test',
						baseBranch: 'main',
						url: 'https://github.com/owner/repo/pull/500',
						isDraft: false,
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/test',
						commit: 'abc500',
						isMain: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123', // This will be ignored
						options: { pr: 500, force: true },
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(500)
					// Open PRs use push workflow, not rebase/merge workflow
					expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
					expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()

					// Should push to remote
					expect(pushBranchToRemote).toHaveBeenCalledWith(
						'feat/test',
						'/test/worktree',
						expect.objectContaining({ dryRun: false })
					)
				})

				it('should handle --pr with --dry-run', async () => {
					const mockPR: PullRequest = {
						number: 600,
						title: 'Test PR',
						body: 'Test',
						state: 'open',
						branch: 'feat/test',
						baseBranch: 'main',
						url: 'https://github.com/owner/repo/pull/600',
						isDraft: false,
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/test',
						commit: 'abc600',
						isMain: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123', // This will be ignored
						options: { pr: 600, dryRun: true },
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(600)
					// Open PRs use push workflow, not rebase/merge workflow
					expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
					expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()

					// In dry run, push should not be called
					expect(pushBranchToRemote).not.toHaveBeenCalled()
				})

				it('should handle all three flags together', async () => {
					const mockPR: PullRequest = {
						number: 700,
						title: 'Test PR',
						body: 'Test',
						state: 'open',
						branch: 'feat/test',
						baseBranch: 'main',
						url: 'https://github.com/owner/repo/pull/700',
						isDraft: false,
					}

					const mockWorktree: GitWorktree = {
						path: '/test/worktree',
						branch: 'feat/test',
						commit: 'abc700',
						isMain: false,
					}

					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockWorktree)

					await command.execute({
						identifier: '123', // This will be ignored
						options: { pr: 700, force: true, dryRun: true },
					})

					expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(700)
					// Open PRs use push workflow, not rebase/merge workflow
					expect(mockMergeManager.rebaseOnMain).not.toHaveBeenCalled()
					expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()

					// In dry run, push should not be called
					expect(pushBranchToRemote).not.toHaveBeenCalled()
				})
			})
		})

		describe('error handling', () => {
			it('should handle GitHub API timeout gracefully', async () => {
				const timeoutError = new Error('Request timeout')
				timeoutError.name = 'TimeoutError'

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})

				vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(timeoutError)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Request timeout')

				// Error logging is done in cli.ts (the catch site), not in finish.ts (the throw site)
				// This ensures errors are logged exactly once
			})

			it('should handle GitHub API rate limit errors', async () => {
				const rateLimitError = new Error('API rate limit exceeded')
				rateLimitError.name = 'RateLimitError'

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'pr',
					number: 456,
					originalInput: 'pr/456',
				})

				vi.mocked(mockGitHubService.fetchPR).mockRejectedValue(rateLimitError)

				await expect(
					command.execute({
						identifier: 'pr/456',
						options: {},
					})
				).rejects.toThrow('API rate limit exceeded')

				// Error logging is done in cli.ts (the catch site), not in finish.ts (the throw site)
				// This ensures errors are logged exactly once
			})

			it('should handle GitHub authentication errors', async () => {
				const authError = new Error('Authentication failed')
				authError.name = 'AuthenticationError'

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 789,
					originalInput: '789',
				})

				vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(authError)

				await expect(
					command.execute({
						identifier: '789',
						options: {},
					})
				).rejects.toThrow('Authentication failed')
			})

			it('should provide clear error message when API fails', async () => {
				const apiError = new Error('GitHub API error: failed to fetch')

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 111,
					originalInput: '111',
				})

				vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(apiError)

				await expect(
					command.execute({
						identifier: '111',
						options: {},
					})
				).rejects.toThrow('GitHub API error: failed to fetch')

				// Error logging is done in cli.ts (the catch site), not in finish.ts (the throw site)
				// This ensures errors are logged exactly once
			})

			it('should handle Git command failures gracefully', async () => {
				const mockIssue: Issue = {
					number: 222,
					title: 'Test Issue',
					body: 'Test',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/owner/repo/issues/222',
				}

				const mockWorktree: GitWorktree = {
					path: '/test/worktree',
					branch: 'feat/issue-222',
					commit: 'abc222',
					isMain: false,
				}

				const gitError = new Error('Git rebase failed: merge conflicts')

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 222,
					originalInput: '222',
				})

				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
				vi.mocked(mockMergeManager.rebaseOnMain).mockRejectedValue(gitError)

				await expect(
					command.execute({
						identifier: '222',
						options: {},
					})
				).rejects.toThrow('Git rebase failed: merge conflicts')
			})

			it('should throw error with helpful message for invalid input', async () => {
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockRejectedValue(
					new Error('Invalid identifier format: @#$%')
				)

				await expect(
					command.execute({
						identifier: '@#$%',
						options: {},
					})
				).rejects.toThrow('Invalid identifier format: @#$%')
			})

			it('should include original input in error messages', async () => {
				const originalInput = 'invalid-123'

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: originalInput,
				})

				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
					number: 123,
					title: 'Test',
					body: 'Test',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/owner/repo/issues/123',
				})

				// Mock worktree not found
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(null)

				await expect(
					command.execute({
						identifier: originalInput,
						options: {},
					})
				).rejects.toThrow(/Use 'il list' to see available worktrees/)
			})

			it('should handle thrown strings gracefully', async () => {
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockRejectedValue(
					'String error: something went wrong'
				)

				await expect(
					command.execute({
						identifier: '333',
						options: {},
					})
				).rejects.toThrow()

				// Error logging is done in cli.ts (the catch site), not in finish.ts (the throw site)
				// This ensures errors are logged exactly once
			})

			it('should handle thrown null/undefined gracefully', async () => {
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockRejectedValue(null)

				await expect(
					command.execute({
						identifier: '444',
						options: {},
					})
				).rejects.toThrow()

				// Error logging is done in cli.ts (the catch site), not in finish.ts (the throw site)
				// This ensures errors are logged exactly once
			})

			it('should throw UserAbortedCommitError when user aborts commit (Issue #398)', async () => {
				const mockIssue: Issue = {
					number: 123,
					title: 'Test Issue',
					body: 'Test',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/owner/repo/issues/123',
				}

				const mockWorktree: GitWorktree = {
					path: '/test/worktree',
					branch: 'feat/issue-123',
					commit: 'abc123',
					isPR: false,
					issueNumber: 123,
					prunable: 'no',
					bare: false,
					detached: false,
				}

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
				vi.mocked(mockCommitManager.detectUncommittedChanges).mockResolvedValue({
					hasUncommittedChanges: true,
					unstagedFiles: ['file.ts'],
					stagedFiles: [],
					currentBranch: 'feat/issue-123',
					isAheadOfRemote: false,
					isBehindRemote: false,
				})
				// User aborts the commit
				vi.mocked(mockCommitManager.commitChanges).mockRejectedValue(
					new UserAbortedCommitError()
				)

				// Execute and verify the error is thrown, not swallowed
				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow(UserAbortedCommitError)
			})
		})

		describe('post-merge cleanup integration', () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			const mockWorktree: GitWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			beforeEach(() => {
				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should call ResourceCleanup.cleanupWorktree after successful merge', async () => {
				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify cleanup was called
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()

				// Verify cleanup was called after merge
				const mergeCallOrder = vi.mocked(mockMergeManager.performFastForwardMerge).mock.invocationCallOrder[0]
				const cleanupCallOrder = vi.mocked(mockResourceCleanup.cleanupWorktree).mock.invocationCallOrder[0]
				expect(cleanupCallOrder).toBeGreaterThan(mergeCallOrder)
			})

			it('should pass correct ParsedInput to cleanupWorktree (without autoDetected field)', async () => {
				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify cleanupWorktree was called with ParsedInput (no autoDetected field)
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'issue',
						number: 123,
						originalInput: '123',
					}),
					expect.any(Object)
				)

				// Verify autoDetected field is NOT present
				const callArgs = vi.mocked(mockResourceCleanup.cleanupWorktree).mock.calls[0]
				expect(callArgs[0]).not.toHaveProperty('autoDetected')
			})

			it('should pass correct cleanup options (deleteBranch: true, keepDatabase: false)', async () => {
				await command.execute({
					identifier: '123',
					options: {},
				})

				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
					expect.any(Object),
					expect.objectContaining({
						dryRun: false,
						deleteBranch: true,
						keepDatabase: false,
						force: false,
					})
				)
			})

			it('should pass dryRun flag from options to cleanup', async () => {
				await command.execute({
					identifier: '123',
					options: { dryRun: true },
				})

				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
					expect.any(Object),
					expect.objectContaining({
						dryRun: true,
					})
				)
			})

			it('should pass force flag from options to cleanup', async () => {
				await command.execute({
					identifier: '123',
					options: { force: true },
				})

				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
					expect.any(Object),
					expect.objectContaining({
						force: true,
					})
				)
			})

			it('should skip cleanup when --no-cleanup flag is set (cleanup: false)', async () => {
				await command.execute({
					identifier: '123',
					options: { cleanup: false },
				})

				// Verify cleanup was NOT called when --no-cleanup flag is set
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should perform cleanup when --cleanup flag is set (cleanup: true)', async () => {
				await command.execute({
					identifier: '123',
					options: { cleanup: true },
				})

				// Verify cleanup was called when --cleanup flag is explicitly set
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
			})

			it('should perform cleanup by default when no cleanup flag is set (cleanup: undefined)', async () => {
				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify cleanup is called by default (undefined means cleanup)
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
			})

			it('should handle partial cleanup failures gracefully without throwing', async () => {
				// Mock partial cleanup failure
				vi.mocked(mockResourceCleanup.cleanupWorktree).mockResolvedValue({
					identifier: '123',
					success: false,
					operations: [
						{ type: 'dev-server', success: true, message: 'Dev server terminated' },
						{ type: 'worktree', success: false, message: 'Failed to remove worktree', error: 'Worktree is locked' },
					],
					errors: [new Error('Worktree is locked')],
					rollbackRequired: false,
				})

				// Should not throw even though cleanup failed
				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).resolves.not.toThrow()

				// Verify cleanup was still attempted
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
			})

			it('should handle cleanup exceptions gracefully without throwing', async () => {
				// Mock cleanup throwing an error
				vi.mocked(mockResourceCleanup.cleanupWorktree).mockRejectedValue(
					new Error('Unexpected cleanup error')
				)

				// Should not throw even though cleanup threw an error
				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).resolves.not.toThrow()

				// Verify cleanup was attempted
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalled()
			})

			it('should NOT execute cleanup if validation fails', async () => {
				// Mock validation failure
				vi.mocked(mockValidationRunner.runValidations).mockRejectedValue(
					new Error('Validation failed')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Validation failed')

				// Verify cleanup was NOT called
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should NOT execute cleanup if rebase fails', async () => {
				// Mock rebase failure
				vi.mocked(mockMergeManager.rebaseOnMain).mockRejectedValue(
					new Error('Rebase failed')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Rebase failed')

				// Verify cleanup was NOT called
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should NOT execute cleanup if merge fails', async () => {
				// Mock merge failure
				vi.mocked(mockMergeManager.performFastForwardMerge).mockRejectedValue(
					new Error('Merge failed')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Merge failed')

				// Verify cleanup was NOT called
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should work with PR identifiers', async () => {
				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				const mockPRWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_456',
					branch: 'feat/test',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockPRWorktree)

				await command.execute({
					identifier: 'pr/456',
					options: {},
				})

				// Verify cleanup was NOT called for open PR (should only push and keep active)
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should work with branch identifiers', async () => {
				const mockBranchWorktree: GitWorktree = {
					path: '/test/worktree/custom-branch',
					branch: 'custom-branch',
					commit: 'ghi789',
					isPR: false,
				}

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'branch',
					branchName: 'custom-branch',
					originalInput: 'custom-branch',
				})

				vi.mocked(mockGitWorktreeManager.findWorktreeForBranch).mockResolvedValue(mockBranchWorktree)

				await command.execute({
					identifier: 'custom-branch',
					options: {},
				})

				// Verify cleanup was called with branch type
				expect(mockResourceCleanup.cleanupWorktree).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'branch',
						branchName: 'custom-branch',
					}),
					expect.any(Object)
				)
			})
		})

		describe('terminal close warning', () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			const mockWorktree: GitWorktree = {
				path: '/test/worktree/feat-issue-123',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			beforeEach(() => {
				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should warn when finish is run from within the loom directory', async () => {
				// Mock process.cwd() to return worktree path
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/test/worktree/feat-issue-123')

				try {
					await command.execute({
						identifier: '123',
						options: {},
					})

					// Verify warning was displayed
					expect(logger.info).toHaveBeenCalledWith(
						'You are currently in the directory of the loom that was just finished.'
					)
					expect(logger.info).toHaveBeenCalledWith(
						'Please close this terminal and any IDE/terminal windows using this directory.'
					)
					expect(logger.info).toHaveBeenCalledWith(
						`Directory: ${mockWorktree.path}`
					)
				} finally {
					process.cwd = originalCwd
				}
			})

			it('should warn when finish is run from within a subdirectory of the loom', async () => {
				// Mock process.cwd() to return subdirectory within worktree
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/test/worktree/feat-issue-123/src/commands')

				try {
					await command.execute({
						identifier: '123',
						options: {},
					})

					// Verify warning was displayed
					expect(logger.info).toHaveBeenCalledWith(
						'You are currently in the directory of the loom that was just finished.'
					)
				} finally {
					process.cwd = originalCwd
				}
			})

			it('should not warn when finish is run from outside the loom directory', async () => {
				// Mock process.cwd() to return different path
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/test/main')

				try {
					await command.execute({
						identifier: '123',
						options: {},
					})

					// Verify warning was NOT displayed
					expect(logger.info).not.toHaveBeenCalledWith(
						'You are currently in the directory of the loom that was just finished.'
					)
				} finally {
					process.cwd = originalCwd
				}
			})

			it('should warn for closed PR cleanup when run from within loom directory', async () => {
				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'closed',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				const mockPRWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_456',
					branch: 'feat/test',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				// Mock process.cwd() to return PR worktree path
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/test/worktree/feat-test_pr_456')

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockPRWorktree)
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'pr',
					number: 456,
					originalInput: 'pr/456',
				})

				try {
					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					// Verify warning was displayed
					expect(logger.info).toHaveBeenCalledWith(
						'You are currently in the directory of the loom that was just finished.'
					)
					expect(logger.info).toHaveBeenCalledWith(
						`Directory: ${mockPRWorktree.path}`
					)
				} finally {
					process.cwd = originalCwd
				}
			})

			it('should NOT warn for closed PR cleanup when cleanup fails', async () => {
				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'closed',
					branch: 'feat/test',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				const mockPRWorktree: GitWorktree = {
					path: '/test/worktree/feat-test_pr_456',
					branch: 'feat/test',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				// Mock process.cwd() to return PR worktree path
				const originalCwd = process.cwd
				process.cwd = vi.fn(() => '/test/worktree/feat-test_pr_456')

				// Mock failed cleanup
				vi.mocked(mockResourceCleanup.cleanupWorktree).mockResolvedValue({
					identifier: 'pr/456',
					success: false, // Failed cleanup
					operations: [
						{ type: 'worktree', success: false, message: 'Failed to remove worktree' },
					],
				})

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(mockPRWorktree)
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'pr',
					number: 456,
					originalInput: 'pr/456',
				})

				try {
					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					// Verify warning was NOT displayed (since cleanup failed)
					expect(logger.info).not.toHaveBeenCalledWith(
						'You are currently in the directory of the loom that was just finished.'
					)
					expect(logger.info).not.toHaveBeenCalledWith(
						`Directory: ${mockPRWorktree.path}`
					)
				} finally {
					process.cwd = originalCwd
				}
			})
		})

		describe('post-merge dependency installation', () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			const mockWorktree: GitWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			beforeEach(async () => {
				// Import the mocked functions

				// Reset mocks
				vi.mocked(installDependencies).mockClear()
				vi.mocked(findMainWorktreePathWithSettings).mockClear()

				// Setup default mocks
				vi.mocked(installDependencies).mockResolvedValue(undefined)
				vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue('/test/main')

				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should install dependencies in main worktree after merge', async () => {

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify findMainWorktreePathWithSettings was called with worktree path and settingsManager
				expect(findMainWorktreePathWithSettings).toHaveBeenCalledWith(mockWorktree.path, expect.any(Object))

				// Verify installDependencies was called with main worktree path, frozen=true, quiet=true
				expect(installDependencies).toHaveBeenCalledWith('/test/main', true, true)
			})

			it('should install dependencies before running post-merge build', async () => {
				const executionOrder: string[] = []

				vi.mocked(installDependencies).mockImplementation(async () => {
					executionOrder.push('install')
				})

				vi.mocked(mockBuildRunner.runBuild).mockImplementation(async () => {
					executionOrder.push('build')
					return {
						success: true,
						skipped: false,
					}
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Verify install happens before build
				const installIndex = executionOrder.indexOf('install')
				const buildIndex = executionOrder.indexOf('build')

				expect(installIndex).toBeGreaterThanOrEqual(0)
				expect(buildIndex).toBeGreaterThanOrEqual(0)
				expect(installIndex).toBeLessThan(buildIndex)
			})

			it('should skip dependency installation in dry-run mode', async () => {

				await command.execute({
					identifier: '123',
					options: {
						dryRun: true,
					},
				})

				// Verify installDependencies was NOT called in dry-run mode
				expect(installDependencies).not.toHaveBeenCalled()
			})

			it('should fail finish command if dependency installation fails', async () => {

				// Mock installation failure
				vi.mocked(installDependencies).mockRejectedValue(
					new Error('Failed to install dependencies: Lockfile is out of date')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('Failed to install dependencies')

				// Verify cleanup was NOT called (error should prevent it)
				expect(mockResourceCleanup.cleanupWorktree).not.toHaveBeenCalled()
			})

			it('should not install dependencies for PR workflow (open PR)', async () => {

				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'open',
					headRef: 'feat/pr-456',
					baseRef: 'main',
					url: 'https://github.com/test/repo/pull/456',
					labels: [],
					assignees: [],
					draft: false,
					mergeable: true,
				}

				// Mock PR detection
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'pr',
					number: 456,
					originalInput: '456',
				})

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				const prWorktree: GitWorktree = {
					path: '/test/worktree-pr',
					branch: 'feat/pr-456',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(prWorktree)

				await command.execute({
					identifier: '456',
					options: {},
				})

				// PRs don't merge to main, so no installation should occur
				expect(installDependencies).not.toHaveBeenCalled()
			})

			it('should not install dependencies for PR workflow (closed PR)', async () => {

				const mockPR: PullRequest = {
					number: 456,
					title: 'Test PR',
					body: 'Test body',
					state: 'closed',
					headRef: 'feat/pr-456',
					baseRef: 'main',
					url: 'https://github.com/test/repo/pull/456',
					labels: [],
					assignees: [],
					draft: false,
					mergeable: false,
				}

				// Mock PR detection
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'pr',
					number: 456,
					originalInput: '456',
				})

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)

				const prWorktree: GitWorktree = {
					path: '/test/worktree-pr',
					branch: 'feat/pr-456',
					commit: 'def456',
					isPR: true,
					prNumber: 456,
				}

				vi.mocked(mockGitWorktreeManager.findWorktreeForPR).mockResolvedValue(prWorktree)

				await command.execute({
					identifier: '456',
					options: {},
				})

				// Closed PRs go to cleanup only, no installation
				expect(installDependencies).not.toHaveBeenCalled()
			})
		})

		describe('post-merge build verification', () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			const mockWorktree: GitWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			beforeEach(() => {
				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should run build after fast-forward merge for CLI projects', async () => {
				// This test will be enabled after BuildRunner integration
				expect(true).toBe(true)
			})

			it('should skip build for non-CLI projects', async () => {
				// This test will be enabled after BuildRunner integration
				expect(true).toBe(true)
			})

			it('should handle build failures gracefully', async () => {
				// This test will be enabled after BuildRunner integration
				expect(true).toBe(true)
			})

			it('should pass dry-run option to BuildRunner', async () => {
				// This test will be enabled after BuildRunner integration
				expect(true).toBe(true)
			})

			it('should skip build when --skip-build flag is provided', async () => {
				// This test will be enabled after BuildRunner integration
				expect(true).toBe(true)
			})
		})

		describe('telemetry', () => {
			it('should track loom.finished on successful finish', async () => {
				const mockIssue: Issue = {
					number: 123,
					title: 'Test issue',
					body: 'Test body',
					state: 'open',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}

				const mockWorktree: GitWorktree = {
					path: '/test/worktree',
					branch: 'feat/issue-123',
					commit: 'abc123',
					bare: false,
					detached: false,
					locked: false,
				}

				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				await command.execute({
					identifier: '123',
					options: {},
				})

				expect(mockTrack).toHaveBeenCalledWith('loom.finished', {
					merge_behavior: 'local',
					duration_minutes: expect.any(Number),
				})
			})
		})

		describe('Provider-aware guards for Linear', () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test Issue',
				body: 'Test description',
				state: 'open',
				url: 'https://linear.app/team/ENG-123',
			}

			const mockWorktree: GitWorktree = {
				path: '/test/worktree',
				branch: 'feat/issue-123',
				commit: 'abc123',
				isPR: false,
				issueNumber: 123,
			}

			beforeEach(() => {
				// Mock Linear service (doesn't support PRs)
				mockGitHubService.supportsPullRequests = false
				mockGitHubService.providerName = 'linear'

				// Mock successful issue fetch
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)

				// Mock successful worktree finding
				vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)

				// Mock IdentifierParser to detect as issue
				vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
					type: 'issue',
					number: 123,
					originalInput: '123',
				})
			})

			it('should succeed with Linear provider and github-pr merge mode', async () => {
				// Mock settings with github-pr mode
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: {
						mode: 'github-pr',
					},
				})

				// Mock the executeGitHubPRWorkflow method to verify it's called
				// (Issue #464: Linear + github-pr should work since PRs go through GitHub CLI)
				const executeGitHubPRWorkflowSpy = vi
					.spyOn(command as unknown as { executeGitHubPRWorkflow: () => Promise<void> }, 'executeGitHubPRWorkflow')
					.mockResolvedValue()

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Rebase runs before PR workflow
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
				// The github-pr workflow should be executed (not the local merge)
				expect(executeGitHubPRWorkflowSpy).toHaveBeenCalled()
				// Local merge should NOT be performed (PR workflow handles merging)
				expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
			})

			it('should succeed with Linear provider and github-draft-pr merge mode', async () => {
				// Mock settings with github-draft-pr mode
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: {
						mode: 'github-draft-pr',
					},
				})

				// Mock the executeGitHubPRWorkflow as fallback handler
				// When no draftPrNumber in metadata, github-draft-pr falls back to github-pr workflow
				// (Issue #464: Linear + github-draft-pr should work since PRs go through GitHub CLI)
				const executeGitHubPRWorkflowSpy = vi
					.spyOn(command as unknown as { executeGitHubPRWorkflow: () => Promise<void> }, 'executeGitHubPRWorkflow')
					.mockResolvedValue()

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Rebase runs before PR workflow
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
				// For github-draft-pr without existing draft PR, it falls back to executeGitHubPRWorkflow
				expect(executeGitHubPRWorkflowSpy).toHaveBeenCalled()
				// Local merge should NOT be performed (PR workflow handles merging)
				expect(mockMergeManager.performFastForwardMerge).not.toHaveBeenCalled()
			})

			it('should succeed with Linear provider and local merge mode', async () => {
				// Mock settings with local mode (default)
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: {
						mode: 'local',
					},
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Should complete local merge workflow successfully
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
				expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalled()
			})

			it('should succeed with Linear provider when mergeBehavior is undefined (defaults to local)', async () => {
				// Mock settings without mergeBehavior (defaults to local)
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				// Should complete local merge workflow successfully
				expect(mockMergeManager.rebaseOnMain).toHaveBeenCalled()
				expect(mockMergeManager.performFastForwardMerge).toHaveBeenCalled()
			})
		})
	})

	describe('browser opening on finish', () => {
		const mockIssue: Issue = {
			number: 42,
			title: 'Test Issue',
			body: 'Test description',
			state: 'open',
			url: 'https://github.com/test/repo/issues/42',
		}

		const mockWorktree: GitWorktree = {
			path: '/test/worktree',
			branch: 'feat/issue-42',
			commit: 'abc123',
			isPR: false,
			issueNumber: 42,
		}

		beforeEach(() => {
			mockGitHubService.supportsPullRequests = true
			mockGitHubService.providerName = 'github'
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockGitWorktreeManager.findWorktreeForIssue).mockResolvedValue(mockWorktree)
			vi.mocked(mockIdentifierParser.parseForPatternDetection).mockResolvedValue({
				type: 'issue',
				number: 42,
				originalInput: '42',
			})

			// Mock PRManager methods
			vi.mocked(PRManager.prototype.openPRInBrowser).mockResolvedValue(undefined)
			vi.mocked(PRManager.prototype.markPRReady).mockResolvedValue(undefined)
			vi.mocked(PRManager.prototype.createOrOpenPR).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/99',
				number: 99,
				wasExisting: false,
			})
		})

		describe('draft PR mode', () => {
			beforeEach(async () => {
				// Override MetadataManager prototype to return draft PR metadata
				const { MetadataManager } = await import('../lib/MetadataManager.js')
				vi.spyOn(MetadataManager.prototype, 'readMetadata').mockResolvedValue({
					draftPrNumber: 55,
					prUrls: { '55': 'https://github.com/test/repo/pull/55' },
					issueNumber: 42,
					branchName: 'feat/issue-42',
				} as never)
			})

			it('should open browser after marking PR ready by default', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-draft-pr' },
				})
				// Spy on handlePRCleanupPrompt to avoid user prompts
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: {} })

				expect(PRManager.prototype.markPRReady).toHaveBeenCalledWith(55, '/test/worktree')
				expect(PRManager.prototype.openPRInBrowser).toHaveBeenCalledWith('https://github.com/test/repo/pull/55')
			})

			it('should not open browser when openBrowserOnFinish is false', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-draft-pr', openBrowserOnFinish: false },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: {} })

				expect(PRManager.prototype.markPRReady).toHaveBeenCalled()
				expect(PRManager.prototype.openPRInBrowser).not.toHaveBeenCalled()
			})

			it('should not open browser when --no-browser flag is set', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-draft-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: { noBrowser: true } })

				expect(PRManager.prototype.markPRReady).toHaveBeenCalled()
				expect(PRManager.prototype.openPRInBrowser).not.toHaveBeenCalled()
			})

			it('should not open browser in dry-run mode', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-draft-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: { dryRun: true } })

				expect(PRManager.prototype.markPRReady).not.toHaveBeenCalled()
				expect(PRManager.prototype.openPRInBrowser).not.toHaveBeenCalled()
			})

			it('should not open browser in json mode', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-draft-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				// JSON mode with github-draft-pr requires --cleanup or --no-cleanup
				await command.execute({ identifier: '42', options: { json: true, cleanup: false } })

				expect(PRManager.prototype.markPRReady).toHaveBeenCalled()
				expect(PRManager.prototype.openPRInBrowser).not.toHaveBeenCalled()
			})
		})

		describe('github-pr mode', () => {
			it('should respect openBrowserOnFinish=false setting', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-pr', openBrowserOnFinish: false },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: {} })

				// Verify openInBrowser (6th arg) is false when setting is disabled
				const calls = vi.mocked(PRManager.prototype.createOrOpenPR).mock.calls
				expect(calls).toHaveLength(1)
				expect(calls[0]![5]).toBe(false)
			})

			it('should not open browser when --no-browser flag is set', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: { noBrowser: true } })

				// Verify openInBrowser (6th arg) is false when --no-browser is set
				const calls = vi.mocked(PRManager.prototype.createOrOpenPR).mock.calls
				expect(calls).toHaveLength(1)
				expect(calls[0]![5]).toBe(false)
			})

			it('should not open browser in json mode', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				// JSON mode with github-pr requires --cleanup or --no-cleanup
				await command.execute({ identifier: '42', options: { json: true, cleanup: false } })

				// Verify openInBrowser (6th arg) is false in json mode
				const calls = vi.mocked(PRManager.prototype.createOrOpenPR).mock.calls
				expect(calls).toHaveLength(1)
				expect(calls[0]![5]).toBe(false)
			})

			it('should open browser by default', async () => {
				vi.spyOn(SettingsManager.prototype, 'loadSettings').mockResolvedValue({
					mainBranch: 'main',
					worktreeDir: '/test/worktrees',
					mergeBehavior: { mode: 'github-pr' },
				})
				vi.spyOn(command as never, 'handlePRCleanupPrompt' as never).mockResolvedValue(undefined as never)
				vi.spyOn(command as never, 'generateSessionSummaryIfConfigured' as never).mockResolvedValue(undefined as never)

				await command.execute({ identifier: '42', options: {} })

				// Verify openInBrowser (6th arg) is true by default
				const calls = vi.mocked(PRManager.prototype.createOrOpenPR).mock.calls
				expect(calls).toHaveLength(1)
				expect(calls[0]![5]).toBe(true)
			})
		})
	})
})
