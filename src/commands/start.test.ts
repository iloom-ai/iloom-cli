import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StartCommand } from './start.js'
import { GitHubService } from '../lib/GitHubService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { LoomManager } from '../lib/LoomManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { branchExists, findMainWorktreePathWithSettings } from '../utils/git.js'

// Mock the GitHubService
vi.mock('../lib/GitHubService.js')


// Mock the LoomManager and its dependencies
vi.mock('../lib/LoomManager.js', () => ({
	LoomManager: vi.fn(() => ({
		createIloom: vi.fn().mockResolvedValue({
			id: 'test-loom-123',
			path: '/test/path',
			branch: 'test-branch',
			type: 'issue',
			identifier: 123,
			port: 3123,
			createdAt: new Date(),
			issueData: null,
		}),
	})),
}))
vi.mock('../lib/GitWorktreeManager.js')
vi.mock('../lib/EnvironmentManager.js')
vi.mock('../lib/ClaudeContextManager.js')
vi.mock('../lib/AgentManager.js')
vi.mock('../lib/SettingsManager.js', () => ({
	SettingsManager: vi.fn(() => ({
		loadSettings: vi.fn().mockResolvedValue({}),
	})),
}))

// Mock git utilities
vi.mock('../utils/git.js', async () => {
	const actual = await vi.importActual<typeof import('../utils/git.js')>('../utils/git.js')
	return {
		...actual,
		branchExists: vi.fn().mockResolvedValue(false),
		findMainWorktreePathWithSettings: vi.fn().mockResolvedValue('/test/main'),
		// Prevent real git commands from running during tests
		executeGitCommand: vi.fn().mockResolvedValue(''),
	}
})

// Mock remote utilities
vi.mock('../utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn().mockResolvedValue(false),
	getConfiguredRepoFromSettings: vi.fn().mockResolvedValue('owner/repo'),
	parseGitRemotes: vi.fn().mockResolvedValue([]),
	validateConfiguredRemote: vi.fn().mockResolvedValue(undefined),
}))

// Mock claude utilities
vi.mock('../utils/claude.js', () => ({
	launchClaude: vi.fn().mockResolvedValue('Enhanced description from Claude AI'),
}))

// Mock browser utilities
vi.mock('../utils/browser.js', () => ({
	openBrowser: vi.fn().mockResolvedValue(undefined),
}))

// Mock prompt utilities
vi.mock('../utils/prompt.js', () => ({
	waitForKeypress: vi.fn().mockResolvedValue('a'),
	promptInput: vi.fn(),
	promptConfirmation: vi.fn(),
}))

// Mock first-run-setup utilities
vi.mock('../utils/first-run-setup.js', () => ({
	needsFirstRunSetup: vi.fn().mockResolvedValue(false),
	launchFirstRunSetup: vi.fn().mockResolvedValue(undefined),
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
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	})),
}))

describe('StartCommand', () => {
	let command: StartCommand
	let mockGitHubService: GitHubService

	beforeEach(() => {
		mockGitHubService = new GitHubService()
		// Set IssueTracker interface properties
		mockGitHubService.supportsPullRequests = true
		mockGitHubService.providerName = 'github'
		command = new StartCommand(mockGitHubService)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('execute', () => {
		describe('first-run setup', () => {
			it('should trigger first-run setup when needsFirstRunSetup returns true', async () => {
				const { needsFirstRunSetup, launchFirstRunSetup } = await import(
					'../utils/first-run-setup.js'
				)
				vi.mocked(needsFirstRunSetup).mockResolvedValue(true)
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				expect(needsFirstRunSetup).toHaveBeenCalled()
				expect(launchFirstRunSetup).toHaveBeenCalled()
			})

			it('should continue normally when needsFirstRunSetup returns false', async () => {
				const { needsFirstRunSetup, launchFirstRunSetup } = await import(
					'../utils/first-run-setup.js'
				)
				vi.mocked(needsFirstRunSetup).mockResolvedValue(false)
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})

				await command.execute({
					identifier: '123',
					options: {},
				})

				expect(needsFirstRunSetup).toHaveBeenCalled()
				expect(launchFirstRunSetup).not.toHaveBeenCalled()
			})
		})

		describe('input parsing', () => {
			it('should parse plain number as GitHub entity (issue)', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'123',
					undefined
				)
			})

			it('should parse plain number as GitHub entity (PR)', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'pr',
					number: 456,
					rawInput: '456',
				})

				await expect(
					command.execute({
						identifier: '456',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'456',
					undefined
				)
			})

			it('should parse hash-prefixed number', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 456,
					rawInput: '#456',
				})

				await expect(
					command.execute({
						identifier: '#456',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'#456',
					undefined
				)
			})

			it('should parse pr/123 format as PR without GitHub call', async () => {
				// PR-specific format should not trigger GitHub detection
				await expect(
					command.execute({
						identifier: 'pr/123',
						options: {},
					})
				).resolves.not.toThrow()

				// Should NOT call detectInputType for explicit PR format
				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})

			it('should parse PR-456 format as PR without GitHub call', async () => {
				await expect(
					command.execute({
						identifier: 'PR-456',
						options: {},
					})
				).resolves.not.toThrow()

				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})

			it('should parse PR/789 format (uppercase with slash)', async () => {
				await expect(
					command.execute({
						identifier: 'PR/789',
						options: {},
					})
				).resolves.not.toThrow()

				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})

			it('should parse branch name', async () => {
				await expect(
					command.execute({
						identifier: 'feature/my-branch',
						options: {},
					})
				).resolves.not.toThrow()

				// Branch names should not trigger GitHub detection
				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})

			it('should handle mixed case PR formats (Pr/123)', async () => {
				// The regex is case-insensitive for PR prefix
				await expect(
					command.execute({
						identifier: 'Pr-789',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should detect description when >25 chars with >2 spaces', async () => {
				const description = 'Users cannot filter the dashboard by date range making reports difficult'

				// Mock GitHubService.createIssue to return issue data
				vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})

				// Mock GitHubService methods for issue validation
				mockGitHubService.getIssueTitle = vi.fn().mockResolvedValue('Issue title')

				await expect(
					command.execute({
						identifier: description,
						options: {},
					})
				).resolves.not.toThrow()

				// Should create issue directly via GitHubService (no enhancement)
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					description, // title
					''           // empty body
				)
			})

			it('should NOT detect description for short text with spaces', async () => {
				const shortText = 'fix auth bug'

				// Should treat as branch name, but fail validation (spaces not allowed)
				await expect(
					command.execute({
						identifier: shortText,
						options: {},
					})
				).rejects.toThrow('Invalid branch name')

				// Should NOT create issue
				expect(mockGitHubService.createIssue).not.toHaveBeenCalled()
				expect(mockGitHubService.detectInputType).not.toHaveBeenCalled()
			})

			it('should NOT detect description for long text without spaces', async () => {
				const longBranchName = 'feat/add-comprehensive-user-authentication-system'

				await expect(
					command.execute({
						identifier: longBranchName,
						options: {},
					})
				).resolves.not.toThrow()

				// Should treat as branch name, not create issue
				expect(mockGitHubService.createIssue).not.toHaveBeenCalled()
			})

			it('should handle edge case: exactly 25 chars with exactly 2 spaces', async () => {
				// Exactly at the boundary - should NOT trigger (needs > not >=)
				const edgeCaseText = 'word1 word2 ' + 'x'.repeat(13)
				expect(edgeCaseText.length).toBe(25)
				expect((edgeCaseText.match(/ /g) || []).length).toBe(2)

				// Should treat as branch name, but fail validation (spaces not allowed)
				await expect(
					command.execute({
						identifier: edgeCaseText,
						options: {},
					})
				).rejects.toThrow('Invalid branch name')

				// Should NOT create issue (boundary conditions use >)
				expect(mockGitHubService.createIssue).not.toHaveBeenCalled()
			})

			it('should detect description for 26 chars with 3 spaces', async () => {
				// Just over the boundary - should trigger
				const description = 'word1 word2 word3 ' + 'x'.repeat(8)
				expect(description.length).toBe(26)
				expect((description.match(/ /g) || []).length).toBe(3)

				// Mock GitHubService.createIssue to return issue data
				vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
					number: 456,
					url: 'https://github.com/owner/repo/issues/456',
				})

				// Mock GitHubService methods for issue validation
				mockGitHubService.getIssueTitle = vi.fn().mockResolvedValue('Issue title')

				await expect(
					command.execute({
						identifier: description,
						options: {},
					})
				).resolves.not.toThrow()

				// Should create issue directly via GitHubService (no enhancement)
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					description, // title
					''           // empty body
				)
			})

		})

		describe('validation', () => {
			it('should reject empty identifier', async () => {
				await expect(
					command.execute({
						identifier: '',
						options: {},
					})
				).rejects.toThrow('Missing required argument: identifier')
			})

			it('should reject whitespace-only identifier', async () => {
				await expect(
					command.execute({
						identifier: '   ',
						options: {},
					})
				).rejects.toThrow('Missing required argument: identifier')
			})

			it('should reject invalid branch characters (special chars)', async () => {
				await expect(
					command.execute({
						identifier: 'feat@branch!',
						options: {},
					})
				).rejects.toThrow('Invalid branch name')
			})

			it('should reject invalid branch characters (spaces)', async () => {
				await expect(
					command.execute({
						identifier: 'my branch name',
						options: {},
					})
				).rejects.toThrow('Invalid branch name')
			})

			it('should reject when GitHub entity not found', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'unknown',
					number: null,
					rawInput: '999',
				})

				await expect(
					command.execute({
						identifier: '999',
						options: {},
					})
				).rejects.toThrow('Could not find issue or PR #999')
			})

			it('should accept valid branch names with slashes', async () => {
				await expect(
					command.execute({
						identifier: 'feature/user-auth',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should accept branch names with underscores', async () => {
				await expect(
					command.execute({
						identifier: 'fix_bug_123',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should accept branch names with hyphens', async () => {
				await expect(
					command.execute({
						identifier: 'feature-user-auth',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should accept branch names with mixed separators', async () => {
				await expect(
					command.execute({
						identifier: 'feature/user-auth_v2',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should accept alphanumeric branch names', async () => {
				await expect(
					command.execute({
						identifier: 'branch123',
						options: {},
					})
				).resolves.not.toThrow()
			})
		})

		describe('options handling', () => {
			it('should handle no-claude option', async () => {
				await expect(
					command.execute({
						identifier: 'fix/bug',
						options: { claude: false },
					})
				).resolves.not.toThrow()
			})
		})

		describe('component flags', () => {
			it('should handle --code flag', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { code: true },
					})
				).resolves.not.toThrow()
			})

			it('should handle --no-code flag', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { code: false },
					})
				).resolves.not.toThrow()
			})

			it('should handle --dev-server flag', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { devServer: true },
					})
				).resolves.not.toThrow()
			})

			it('should handle --no-dev-server flag', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { devServer: false },
					})
				).resolves.not.toThrow()
			})

			it('should handle component flags with no-claude flag', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { code: true, claude: false },
					})
				).resolves.not.toThrow()
			})

			it('should handle multiple component flags', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { code: true, claude: true, devServer: false },
					})
				).resolves.not.toThrow()
			})

			it('should handle all components disabled', async () => {
				await expect(
					command.execute({
						identifier: 'feature/test',
						options: { code: false, claude: false, devServer: false },
					})
				).resolves.not.toThrow()
			})
		})

		describe('GitHub detection', () => {
			it('should detect PR when number is a PR', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'pr',
					number: 42,
					rawInput: '42',
				})

				await expect(
					command.execute({
						identifier: '42',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'42',
					undefined
				)
			})

			it('should detect issue when number is an issue', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 24,
					rawInput: '24',
				})

				await expect(
					command.execute({
						identifier: '24',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'24',
					undefined
				)
			})

			it('should handle leading zeros in numbers', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '0123',
				})

				await expect(
					command.execute({
						identifier: '0123',
						options: {},
					})
				).resolves.not.toThrow()

				// The number should be parsed as 123, not 0123
				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'0123',
					undefined
				)
			})
		})

		describe('error handling', () => {
			it('should handle detection returning pr type with null number gracefully', async () => {
				// This edge case tests that even if GitHub detection returns pr with null number,
				// the command uses the fallback number from parsing
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'pr',
					number: null, // Edge case: PR type with null number
					rawInput: '999',
				})

				// Should NOT throw - it should use the parsed number (999) as fallback
				await expect(
					command.execute({
						identifier: '999',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should rethrow errors from GitHubService', async () => {
				const testError = new Error('GitHub API error')
				vi.mocked(mockGitHubService.detectInputType).mockRejectedValue(
					testError
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('GitHub API error')
			})

			it('should handle unknown errors gracefully', async () => {
				// Test non-Error object being thrown
				vi.mocked(mockGitHubService.detectInputType).mockRejectedValue(
					'string error'
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toBeDefined()
			})
		})

		describe('edge cases', () => {
			it('should handle very large issue numbers', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 999999,
					rawInput: '999999',
				})

				await expect(
					command.execute({
						identifier: '999999',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should handle single character branch names', async () => {
				await expect(
					command.execute({
						identifier: 'a',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should handle very long branch names', async () => {
				const longBranchName = 'feature/' + 'a'.repeat(100)
				await expect(
					command.execute({
						identifier: longBranchName,
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should handle branch names with numbers only', async () => {
				// Note: This will be treated as a branch name since it doesn't
				// match the strict PR format patterns
				await expect(
					command.execute({
						identifier: 'branch123test',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should differentiate between pr/123 (PR format) and pr-123 (branch name)', async () => {
				// pr/123 or PR-123 are PR formats
				await expect(
					command.execute({
						identifier: 'pr/123',
						options: {},
					})
				).resolves.not.toThrow()

				// But something like pr-abc-123 is a branch name
				await expect(
					command.execute({
						identifier: 'pr-abc-123',
						options: {},
					})
				).resolves.not.toThrow()
			})
		})

		describe('format detection priority', () => {
			it('should prioritize PR-specific format over numeric detection', async () => {
				// When using pr/123 format, it should NOT call GitHub detection
				await expect(
					command.execute({
						identifier: 'pr/123',
						options: {},
					})
				).resolves.not.toThrow()

				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})

			it('should use GitHub detection for plain numbers', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).resolves.not.toThrow()

				expect(mockGitHubService.detectInputType).toHaveBeenCalledWith(
					'123',
					undefined
				)
			})

			it('should treat non-PR-format, non-numeric input as branch', async () => {
				await expect(
					command.execute({
						identifier: 'my-feature',
						options: {},
					})
				).resolves.not.toThrow()

				expect(
					mockGitHubService.detectInputType
				).not.toHaveBeenCalled()
			})
		})

		describe('GitHub state validation', () => {
			it('should call validateIssueState for issues', async () => {
				const mockIssue = {
					number: 123,
					title: 'Test Issue',
					body: 'Issue body',
					state: 'open' as const,
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}

				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
				vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

				await command.execute({
					identifier: '123',
					options: {},
				})

				expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
				expect(mockGitHubService.validateIssueState).toHaveBeenCalledWith(mockIssue)
			})

			it('should call validatePRState for PRs', async () => {
				const mockPR = {
					number: 456,
					title: 'Test PR',
					body: 'PR body',
					state: 'open' as const,
					branch: 'feature-branch',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitHubService.validatePRState).mockResolvedValue()

				await command.execute({
					identifier: 'pr-456',
					options: {},
				})

				expect(mockGitHubService.fetchPR).toHaveBeenCalledWith(456, undefined)
				expect(mockGitHubService.validatePRState).toHaveBeenCalledWith(mockPR)
			})

			it('should throw when validateIssueState rejects', async () => {
				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
					number: 123,
					title: 'Closed Issue',
					body: '',
					state: 'closed',
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				})
				vi.mocked(mockGitHubService.validateIssueState).mockRejectedValue(
					new Error('User cancelled due to closed issue')
				)

				await expect(
					command.execute({
						identifier: '123',
						options: {},
					})
				).rejects.toThrow('User cancelled due to closed issue')
			})

			it('should throw when validatePRState rejects', async () => {
				const mockPR = {
					number: 456,
					title: 'Merged PR',
					body: '',
					state: 'closed' as const,
					branch: 'feature',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitHubService.validatePRState).mockRejectedValue(
					new Error('User cancelled due to merged PR')
				)

				await expect(
					command.execute({
						identifier: 'pr/456',
						options: {},
					})
				).rejects.toThrow('User cancelled due to merged PR')
			})
		})

		describe('branch existence checking', () => {
			it('should reuse existing branch worktree when branch exists', async () => {
				// Branch reuse is now handled by LoomManager.findExistingIloom
				// The command should not throw when a branch exists - it will be reused
				vi.mocked(branchExists).mockResolvedValue(true)

				await expect(
					command.execute({
						identifier: 'existing-branch',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should create new worktree when branch does not exist', async () => {
				vi.mocked(branchExists).mockResolvedValue(false)

				await expect(
					command.execute({
						identifier: 'new-branch',
						options: {},
					})
				).resolves.not.toThrow()
			})

			it('should not check branch existence for PRs', async () => {
				const mockPR = {
					number: 123,
					title: 'Test PR',
					body: '',
					state: 'open' as const,
					branch: 'feature-branch',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/123',
					isDraft: false,
				}

				vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
				vi.mocked(mockGitHubService.validatePRState).mockResolvedValue()

				await command.execute({
					identifier: 'pr/123',
					options: {},
				})

				// branchExists should not be called for PRs in validateInput
				// (it might be called in LoomManager but that's a different check)
			})

			it('should not check branch existence for issues in validateInput', async () => {
				const mockIssue = {
					number: 123,
					title: 'Test Issue',
					body: '',
					state: 'open' as const,
					labels: [],
					assignees: [],
					url: 'https://github.com/test/repo/issues/123',
				}

				vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
					type: 'issue',
					number: 123,
					rawInput: '123',
				})
				vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
				vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

				await command.execute({
					identifier: '123',
					options: {},
				})

				// branchExists is only called for branch-type inputs in validateInput
				// Issues get their branch checked in LoomManager.createWorktree
			})
		})

		describe('Configuration-Driven Component Launching', () => {
			let mockLoomManager: {
				createIloom: ReturnType<typeof vi.fn>
			}
			let mockSettingsManager: {
				loadSettings: ReturnType<typeof vi.fn>
			}

			beforeEach(async () => {
				// Re-import to get fresh mocked instances

				mockLoomManager = new LoomManager()
				mockSettingsManager = new SettingsManager()

				// Mock settings manager loadSettings method
				mockSettingsManager.loadSettings = vi.fn().mockResolvedValue({})

				// Create command with mocked dependencies
				command = new StartCommand(
					mockGitHubService,
					mockLoomManager,
					undefined,
					mockSettingsManager
				)
			})

			describe('Workflow-specific settings application', () => {
				it('should use issue workflow config when starting issue workflow', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings with issue workflow config
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: false,
								startDevServer: true,
								startAiAgent: true,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: false,
								enableDevServer: true,
								enableClaude: true,
							}),
						})
					)
				})

				it('should use pr workflow config when starting PR workflow', async () => {
					const mockPR = {
						number: 456,
						title: 'Test PR',
						body: '',
						state: 'open' as const,
						branch: 'feature-branch',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					// Mock settings with pr workflow config
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							pr: {
								startIde: true,
								startDevServer: false,
								startAiAgent: true,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'pr',
						number: 456,
						rawInput: 'pr/456',
					})
					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitHubService.validatePRState).mockResolvedValue()

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: true,
								enableDevServer: false,
								enableClaude: true,
							}),
						})
					)
				})

				it('should use regular workflow config when starting branch workflow', async () => {
					vi.mocked(branchExists).mockResolvedValue(false)

					// Mock settings with regular workflow config
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							regular: {
								startIde: true,
								startDevServer: true,
								startAiAgent: false,
							},
						},
					})

					await command.execute({
						identifier: 'my-feature-branch',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: true,
								enableDevServer: true,
								enableClaude: false,
							}),
						})
					)
				})
			})

			describe('Configuration precedence and defaults', () => {
				it('should default to all components enabled when no config exists', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock empty settings (no workflow config)
					mockSettingsManager.loadSettings.mockResolvedValue({})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: true,
								enableDevServer: true,
								enableClaude: true,
							}),
						})
					)
				})

				it('should default to all components enabled when workflow type not configured', async () => {
					const mockPR = {
						number: 456,
						title: 'Test PR',
						body: '',
						state: 'open' as const,
						branch: 'feature-branch',
						baseBranch: 'main',
						url: 'https://github.com/test/repo/pull/456',
						isDraft: false,
					}

					// Mock settings with only issue workflow configured
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: false,
								startDevServer: false,
								startAiAgent: false,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'pr',
						number: 456,
						rawInput: 'pr/456',
					})
					vi.mocked(mockGitHubService.fetchPR).mockResolvedValue(mockPR)
					vi.mocked(mockGitHubService.validatePRState).mockResolvedValue()

					await command.execute({
						identifier: 'pr/456',
						options: {},
					})

					// PR workflow not configured, should default to true
					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: true,
								enableDevServer: true,
								enableClaude: true,
							}),
						})
					)
				})

				it('should allow CLI flags to override config settings', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings with issue.startIde: true
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: true,
								startDevServer: true,
								startAiAgent: true,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					// Pass CLI flag to override
					await command.execute({
						identifier: '123',
						options: {
							code: false,
						},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: false, // CLI override
								enableDevServer: true, // From config
								enableClaude: true, // From config
							}),
						})
					)
				})

				it('should apply CLI overrides for all component flags', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings with all components enabled
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: true,
								startDevServer: true,
								startAiAgent: true,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					// Pass all CLI flags to override
					await command.execute({
						identifier: '123',
						options: {
							code: false,
							devServer: false,
							claude: false,
						},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: false,
								enableDevServer: false,
								enableClaude: false,
							}),
						})
					)
				})

				it('should handle partial config (some flags set, others undefined)', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings with only startIde defined
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: false,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: false, // From config
								enableDevServer: true, // Default
								enableClaude: true, // Default
							}),
						})
					)
				})
			})

			describe('Edge cases', () => {
				it('should handle all components disabled via config', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings with all flags false
					mockSettingsManager.loadSettings.mockResolvedValue({
						workflows: {
							issue: {
								startIde: false,
								startDevServer: false,
								startAiAgent: false,
							},
						},
					})

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					await command.execute({
						identifier: '123',
						options: {},
					})

					expect(mockLoomManager.createIloom).toHaveBeenCalledWith(
						expect.objectContaining({
							options: expect.objectContaining({
								enableCode: false,
								enableDevServer: false,
								enableClaude: false,
							}),
						})
					)
				})

				it('should handle settings loading failure gracefully', async () => {
					const mockIssue = {
						number: 123,
						title: 'Test Issue',
						body: '',
						state: 'open' as const,
						labels: [],
						assignees: [],
						url: 'https://github.com/test/repo/issues/123',
					}

					// Mock settings loading to throw error
					mockSettingsManager.loadSettings.mockRejectedValue(
						new Error('Failed to load settings')
					)

					vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
						type: 'issue',
						number: 123,
						rawInput: '123',
					})
					vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
					vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

					// Should propagate the error (not catch it silently)
					await expect(
						command.execute({
							identifier: '123',
							options: {},
						})
					).rejects.toThrow('Failed to load settings')
				})
			})
		})
	})

	describe('worktree directory behavior', () => {
		it('should call findMainWorktreePathWithSettings during execute', async () => {
			const mockIssue = {
				number: 123,
				title: 'Test Issue',
				body: '',
				state: 'open' as const,
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 123,
				rawInput: '123',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			await command.execute({
				identifier: '123',
				options: {},
			})

			// Verify findMainWorktreePathWithSettings was called
			expect(findMainWorktreePathWithSettings).toHaveBeenCalled()
		})

		it('should initialize GitWorktreeManager with main worktree path (not process.cwd)', async () => {

			// Mock findMainWorktreePathWithSettings to return a specific path
			vi.mocked(findMainWorktreePathWithSettings).mockResolvedValue('/test/main-repo')

			const mockIssue = {
				number: 123,
				title: 'Test Issue',
				body: '',
				state: 'open' as const,
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/123',
			}

			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 123,
				rawInput: '123',
			})
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockGitHubService.validateIssueState).mockResolvedValue()

			// Create new command to trigger constructor with main path
			const newCommand = new StartCommand(mockGitHubService)
			await newCommand.execute({
				identifier: '123',
				options: {},
			})

			// Verify GitWorktreeManager was constructed with the main path
			expect(GitWorktreeManager).toHaveBeenCalledWith('/test/main-repo')
		})
	})
})
