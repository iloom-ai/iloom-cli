import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StartCommand } from './start.js'
import { GitHubService } from '../lib/GitHubService.js'
import { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import { LoomManager } from '../lib/LoomManager.js'
import { SettingsManager } from '../lib/SettingsManager.js'
import { branchExists, findMainWorktreePathWithSettings } from '../utils/git.js'
import { fetchChildIssues, fetchChildIssueDetails } from '../utils/list-children.js'
import { buildDependencyMap } from '../utils/dependency-map.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'

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
	launchClaude: vi.fn().mockResolvedValue('Enhanced description from Claude Code'),
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
	isInteractiveEnvironment: vi.fn().mockReturnValue(true),
}))

// Mock first-run-setup utilities
vi.mock('../utils/first-run-setup.js', () => ({
	needsFirstRunSetup: vi.fn().mockResolvedValue(false),
	launchFirstRunSetup: vi.fn().mockResolvedValue(undefined),
}))

// Mock list-children utilities for epic detection
vi.mock('../utils/list-children.js', () => ({
	fetchChildIssues: vi.fn().mockResolvedValue([]),
	fetchChildIssueDetails: vi.fn().mockResolvedValue([]),
}))

// Mock dependency-map utilities
vi.mock('../utils/dependency-map.js', () => ({
	buildDependencyMap: vi.fn().mockResolvedValue({}),
}))

// Mock TelemetryService
const mockTrack = vi.fn()
vi.mock('../lib/TelemetryService.js', () => ({
	TelemetryService: {
		getInstance: () => ({ track: mockTrack }),
	},
}))

// Mock IssueTrackerFactory for epic child data fetching
vi.mock('../lib/IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		create: vi.fn().mockReturnValue({
			fetchIssue: vi.fn().mockResolvedValue({
				number: 0,
				title: '',
				body: '',
				state: 'open',
				labels: [],
				assignees: [],
				url: '',
			}),
			providerName: 'github',
		}),
		getProviderName: vi.fn().mockReturnValue('github'),
	},
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

		// Default: no child issues (epic detection returns empty)
		vi.mocked(fetchChildIssues).mockResolvedValue([])
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
				const description = 'users cannot filter the dashboard by date range making reports difficult'

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
				// Title is auto-capitalized
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					'Users cannot filter the dashboard by date range making reports difficult', // title (first letter capitalized)
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

			it('should handle edge case: exactly 15 chars with exactly 2 spaces', async () => {
				// Exactly at the boundary - should NOT trigger (needs > not >=)
				const edgeCaseText = 'word1 word2 xxx'
				expect(edgeCaseText.length).toBe(15)
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

			it('should detect description for 16 chars with 2 spaces', async () => {
				// Just over the boundary - should trigger
				const description = 'word1 word2 xxxx'
				expect(description.length).toBe(16)
				expect((description.match(/ /g) || []).length).toBe(2)

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
				// Title is auto-capitalized
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					'Word1 word2 xxxx', // title (first letter capitalized)
					''                  // empty body
				)
			})

			it('should skip capitalization when description starts with space (override)', async () => {
				// User prefixes with space to skip auto-capitalization
				const description = ' this is a test issue that should not be capitalized'

				// Mock GitHubService.createIssue to return issue data
				vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
					number: 789,
					url: 'https://github.com/owner/repo/issues/789',
				})

				// Mock GitHubService methods for issue validation
				mockGitHubService.getIssueTitle = vi.fn().mockResolvedValue('Issue title')

				await expect(
					command.execute({
						identifier: description,
						options: {},
					})
				).resolves.not.toThrow()

				// Leading space triggers override: strip space, don't capitalize
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					'this is a test issue that should not be capitalized', // NOT capitalized
					''
				)
			})

			it('should skip capitalization for body when it starts with space (override)', async () => {
				// User prefixes both title and body with space to skip auto-capitalization
				const description = ' title that should not be capitalized here'
				const body = ' body that should also not be capitalized'

				// Mock GitHubService.createIssue to return issue data
				vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
					number: 790,
					url: 'https://github.com/owner/repo/issues/790',
				})

				// Mock GitHubService methods for issue validation
				mockGitHubService.getIssueTitle = vi.fn().mockResolvedValue('Issue title')

				await expect(
					command.execute({
						identifier: description,
						options: { body },
					})
				).resolves.not.toThrow()

				// Both should have leading space stripped without capitalization
				expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
					'title that should not be capitalized here', // NOT capitalized
					'body that should also not be capitalized'   // NOT capitalized
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

	describe('telemetry', () => {
		it('should track loom.created on successful start', async () => {
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 123,
				rawInput: '123',
			})

			await command.execute({
				identifier: '123',
				options: {},
			})

			expect(mockTrack).toHaveBeenCalledWith('loom.created', {
				source_type: 'issue',
				tracker: 'github',
				is_child_loom: false,
				one_shot_mode: 'default',
			})
		})

		it('should map oneShot noReview to skip-reviews', async () => {
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 123,
				rawInput: '123',
			})

			await command.execute({
				identifier: '123',
				options: { oneShot: 'noReview' },
			})

			expect(mockTrack).toHaveBeenCalledWith('loom.created', expect.objectContaining({
				one_shot_mode: 'skip-reviews',
			}))
		})

		it('should map oneShot bypassPermissions to yolo', async () => {
			vi.mocked(mockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				number: 123,
				rawInput: '123',
			})

			// Mock the bypassPermissions confirmation prompt to approve
			const { promptConfirmation } = await import('../utils/prompt.js')
			vi.mocked(promptConfirmation).mockResolvedValue(true)

			await command.execute({
				identifier: '123',
				options: { oneShot: 'bypassPermissions' },
			})

			expect(mockTrack).toHaveBeenCalledWith('loom.created', expect.objectContaining({
				one_shot_mode: 'yolo',
			}))
		})

		it('should not track on failure', async () => {
			vi.mocked(mockGitHubService.detectInputType).mockRejectedValue(
				new Error('API error')
			)

			await expect(
				command.execute({ identifier: '123', options: {} })
			).rejects.toThrow('API error')

			expect(mockTrack).not.toHaveBeenCalled()
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

	describe('Linear as issue tracker with GitHub PRs', () => {
		let mockLinearService: {
			supportsPullRequests: boolean
			providerName: string
			detectInputType: ReturnType<typeof vi.fn>
			fetchIssue: ReturnType<typeof vi.fn>
			validateIssueState: ReturnType<typeof vi.fn>
			fetchPR?: ReturnType<typeof vi.fn>
			validatePRState?: ReturnType<typeof vi.fn>
		}
		let linearCommand: StartCommand

		beforeEach(() => {
			// Create a mock Linear service that doesn't support PRs
			mockLinearService = {
				supportsPullRequests: false,
				providerName: 'linear',
				detectInputType: vi.fn(),
				fetchIssue: vi.fn(),
				validateIssueState: vi.fn(),
				// Linear does NOT have fetchPR or validatePRState
			}
			linearCommand = new StartCommand(mockLinearService as unknown as GitHubService)
		})

		describe('GitHub PR detection via numeric input', () => {
			it('should detect GitHub PR from numeric input when Linear is configured', async () => {
				const mockPR = {
					number: 42,
					title: 'Test PR',
					body: '',
					state: 'open' as const,
					branch: 'feature-branch',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/42',
					isDraft: false,
				}

				// GitHubService will be instantiated internally via getGitHubService()
				// We need to mock the GitHubService class methods
				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.detectInputType = vi.fn().mockResolvedValue({
					type: 'pr',
					identifier: '42',
					rawInput: '42',
				})
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockResolvedValue(undefined)

				await expect(
					linearCommand.execute({
						identifier: '42',
						options: {},
					})
				).resolves.not.toThrow()

				// Verify GitHubService.detectInputType was called (not LinearService)
				expect(MockedGitHubService.prototype.detectInputType).toHaveBeenCalledWith('42', undefined)
				// LinearService.detectInputType should NOT be called for numeric input
				expect(mockLinearService.detectInputType).not.toHaveBeenCalled()
			})

			it('should detect GitHub PR from hash-prefixed numeric input when Linear is configured', async () => {
				const mockPR = {
					number: 42,
					title: 'Test PR',
					body: '',
					state: 'open' as const,
					branch: 'feature-branch',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/42',
					isDraft: false,
				}

				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.detectInputType = vi.fn().mockResolvedValue({
					type: 'pr',
					identifier: '42',
					rawInput: '#42',
				})
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockResolvedValue(undefined)

				await expect(
					linearCommand.execute({
						identifier: '#42',
						options: {},
					})
				).resolves.not.toThrow()

				expect(MockedGitHubService.prototype.detectInputType).toHaveBeenCalledWith('#42', undefined)
			})

			it('should fall back to issue tracker when GitHub issue is found', async () => {
				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.detectInputType = vi.fn().mockResolvedValue({
					type: 'issue',
					identifier: '42',
					rawInput: '42',
				})

				// Mock Linear's fetchIssue to fail (as expected for numeric input)
				mockLinearService.fetchIssue.mockRejectedValue(new Error('Issue not found'))

				await expect(
					linearCommand.execute({
						identifier: '42',
						options: {},
					})
				).rejects.toThrow('Issue not found')

				// Should have called Linear's fetchIssue, not thrown GitHub-specific error
				expect(mockLinearService.fetchIssue).toHaveBeenCalledWith(42, undefined)
			})

			it('should fall back to issue tracker when nothing is found on GitHub', async () => {
				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.detectInputType = vi.fn().mockResolvedValue({
					type: 'unknown',
					identifier: null,
					rawInput: '999',
				})

				// Mock Linear's fetchIssue to fail
				mockLinearService.fetchIssue.mockRejectedValue(new Error('Issue not found'))

				await expect(
					linearCommand.execute({
						identifier: '999',
						options: {},
					})
				).rejects.toThrow('Issue not found')

				// Should have tried the issue tracker
				expect(mockLinearService.fetchIssue).toHaveBeenCalledWith(999, undefined)
			})
		})

		describe('PR validation with Linear', () => {
			it('should validate PR state using GitHubService when Linear is configured', async () => {
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

				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockResolvedValue(undefined)

				// Use explicit PR format which doesn't require detection
				await linearCommand.execute({
					identifier: 'pr/456',
					options: {},
				})

				// Verify GitHubService was used for PR validation (not LinearService)
				expect(MockedGitHubService.prototype.fetchPR).toHaveBeenCalledWith(456, undefined)
				expect(MockedGitHubService.prototype.validatePRState).toHaveBeenCalledWith(mockPR)
			})

			it('should handle closed PRs with user prompt using GitHubService', async () => {
				const mockPR = {
					number: 456,
					title: 'Closed PR',
					body: '',
					state: 'closed' as const,
					branch: 'feature-branch',
					baseBranch: 'main',
					url: 'https://github.com/test/repo/pull/456',
					isDraft: false,
				}

				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockRejectedValue(
					new Error('User cancelled due to closed PR')
				)

				await expect(
					linearCommand.execute({
						identifier: 'pr/456',
						options: {},
					})
				).rejects.toThrow('User cancelled due to closed PR')
			})
		})

		describe('explicit PR format with Linear', () => {
			it('should use explicit pr/123 format without GitHub detection call', async () => {
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

				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockResolvedValue(undefined)
				MockedGitHubService.prototype.detectInputType = vi.fn()

				await linearCommand.execute({
					identifier: 'pr/123',
					options: {},
				})

				// detectInputType should NOT be called for explicit PR format
				expect(MockedGitHubService.prototype.detectInputType).not.toHaveBeenCalled()
				// But fetchPR and validatePRState should be called
				expect(MockedGitHubService.prototype.fetchPR).toHaveBeenCalledWith(123, undefined)
				expect(MockedGitHubService.prototype.validatePRState).toHaveBeenCalledWith(mockPR)
			})

			it('should use PR-123 format without GitHub detection call', async () => {
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

				const MockedGitHubService = vi.mocked(GitHubService)
				MockedGitHubService.prototype.fetchPR = vi.fn().mockResolvedValue(mockPR)
				MockedGitHubService.prototype.validatePRState = vi.fn().mockResolvedValue(undefined)
				MockedGitHubService.prototype.detectInputType = vi.fn()

				await linearCommand.execute({
					identifier: 'PR-123',
					options: {},
				})

				expect(MockedGitHubService.prototype.detectInputType).not.toHaveBeenCalled()
				expect(MockedGitHubService.prototype.fetchPR).toHaveBeenCalledWith(123, undefined)
			})
		})

		describe('Linear issue handling', () => {
			it('should still handle Linear issue identifiers correctly', async () => {
				// Mock LinearService.detectInputType to find a Linear issue
				mockLinearService.detectInputType.mockResolvedValue({
					type: 'issue',
					identifier: 'ENG-123',
					rawInput: 'ENG-123',
				})

				await expect(
					linearCommand.execute({
						identifier: 'ENG-123',
						options: {},
					})
				).resolves.not.toThrow()

				// LinearService.detectInputType should be called for Linear identifier format
				expect(mockLinearService.detectInputType).toHaveBeenCalledWith('ENG-123', undefined)
			})
		})
	})

	describe('epic detection', () => {
		let epicCommand: StartCommand
		let epicMockGitHubService: GitHubService
		let epicMockLoomManager: { createIloom: ReturnType<typeof vi.fn> }

		beforeEach(() => {
			epicMockGitHubService = new GitHubService()
			epicMockGitHubService.supportsPullRequests = true
			epicMockGitHubService.providerName = 'github'

			epicMockLoomManager = new LoomManager() as unknown as { createIloom: ReturnType<typeof vi.fn> }

			epicCommand = new StartCommand(epicMockGitHubService, epicMockLoomManager as unknown as LoomManager)

			// Setup issue detection
			vi.mocked(epicMockGitHubService.detectInputType).mockResolvedValue({
				type: 'issue',
				identifier: '100',
				rawInput: '100',
			})
			vi.mocked(epicMockGitHubService.fetchIssue).mockResolvedValue({
				number: 100,
				title: 'Epic Issue',
				body: 'Parent issue with children',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/test/repo/issues/100',
			})
			vi.mocked(epicMockGitHubService.validateIssueState).mockResolvedValue()

			// Default: no child issues (epic detection returns empty)
			vi.mocked(fetchChildIssues).mockResolvedValue([])
			// Default: empty child issue details and dependency map
			vi.mocked(fetchChildIssueDetails).mockResolvedValue([])
			vi.mocked(buildDependencyMap).mockResolvedValue({})
			// Re-setup IssueTrackerFactory.create (reset by vitest mockReset)
			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				fetchIssue: vi.fn().mockResolvedValue({ number: 0, title: '', body: '', state: 'open', labels: [], assignees: [], url: '' }),
				providerName: 'github',
			} as unknown as ReturnType<typeof IssueTrackerFactory.create>)
		})

		it('should prompt user when issue has children and no --epic flag', async () => {
			const { promptConfirmation, isInteractiveEnvironment } = await import('../utils/prompt.js')
			vi.mocked(isInteractiveEnvironment).mockReturnValue(true)
			vi.mocked(promptConfirmation).mockResolvedValue(true)

			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
				{ id: '102', title: 'Child 2', url: 'https://github.com/test/repo/issues/102', state: 'open' },
			])

			await epicCommand.execute({
				identifier: '100',
				options: {},
			})

			expect(promptConfirmation).toHaveBeenCalledWith(
				'This issue has 2 child issue(s). Create as epic loom?',
				true
			)
		})

		it('should create epic loom with --epic flag without prompting', async () => {
			const { promptConfirmation } = await import('../utils/prompt.js')

			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
			])

			await epicCommand.execute({
				identifier: '100',
				options: { epic: true },
			})

			expect(promptConfirmation).not.toHaveBeenCalled()
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'epic',
					options: expect.objectContaining({
						childIssueNumbers: ['101'],
					}),
				})
			)
		})

		it('should create normal loom with --no-epic flag without prompting', async () => {
			const { promptConfirmation } = await import('../utils/prompt.js')

			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
			])

			await epicCommand.execute({
				identifier: '100',
				options: { epic: false },
			})

			expect(promptConfirmation).not.toHaveBeenCalled()
			// type should remain 'issue', not 'epic'
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
				})
			)
		})

		it('should throw in JSON mode when children detected but no explicit --epic/--no-epic flag', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
			])

			await expect(
				epicCommand.execute({
					identifier: '100',
					options: { json: true },
				})
			).rejects.toThrow('JSON mode requires explicit --epic or --no-epic flag when issue has child issues')
		})

		it('should proceed normally when issue has no children', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([])

			await epicCommand.execute({
				identifier: '100',
				options: {},
			})

			// type should remain 'issue', not 'epic'
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
				})
			)
		})

		it('should silently ignore --epic flag and proceed normally when no children exist', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([])

			await epicCommand.execute({
				identifier: '100',
				options: { epic: true },
			})

			// type should remain 'issue' since there are no children
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
				})
			)
		})

		it('should pass childIssueNumbers in JSON result when epic', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '201', title: 'Child A', url: 'https://github.com/test/repo/issues/201', state: 'open' },
				{ id: '202', title: 'Child B', url: 'https://github.com/test/repo/issues/202', state: 'closed' },
			])

			const result = await epicCommand.execute({
				identifier: '100',
				options: { epic: true, json: true },
			})

			expect(result).toEqual(expect.objectContaining({
				type: 'epic',
				childIssueNumbers: ['201', '202'],
			}))
		})

		it('should fetch and pass childIssues and dependencyMap when creating epic loom', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
				{ id: '102', title: 'Child 2', url: 'https://github.com/test/repo/issues/102', state: 'open' },
			])

			vi.mocked(fetchChildIssueDetails).mockResolvedValue([
				{ number: '#101', title: 'Child 1', body: 'Body 1', url: 'https://github.com/test/repo/issues/101' },
				{ number: '#102', title: 'Child 2', body: 'Body 2', url: 'https://github.com/test/repo/issues/102' },
			])

			vi.mocked(buildDependencyMap).mockResolvedValue({
				'#101': [],
				'#102': ['#101'],
			})

			await epicCommand.execute({
				identifier: '100',
				options: { epic: true },
			})

			expect(fetchChildIssueDetails).toHaveBeenCalledWith('100', expect.anything(), undefined)
			expect(buildDependencyMap).toHaveBeenCalledWith(['101', '102'], expect.anything(), undefined)
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'epic',
					options: expect.objectContaining({
						childIssueNumbers: ['101', '102'],
						childIssues: [
							{ number: '#101', title: 'Child 1', body: 'Body 1', url: 'https://github.com/test/repo/issues/101' },
							{ number: '#102', title: 'Child 2', body: 'Body 2', url: 'https://github.com/test/repo/issues/102' },
						],
						dependencyMap: {
							'#101': [],
							'#102': ['#101'],
						},
					}),
				})
			)
		})

		it('should revert to normal loom when fetchChildIssueDetails fails', async () => {
			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
			])

			vi.mocked(fetchChildIssueDetails).mockRejectedValue(new Error('API error'))

			await epicCommand.execute({
				identifier: '100',
				options: { epic: true },
			})

			// Should revert to issue type since child data fetch failed
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
				})
			)
			// Should not include childIssueNumbers since epic was reverted
			const createCall = epicMockLoomManager.createIloom.mock.calls[0][0]
			expect(createCall.options.childIssueNumbers).toBeUndefined()
		})

		it('should not fetch childIssueDetails when user declines epic mode', async () => {
			const { promptConfirmation, isInteractiveEnvironment } = await import('../utils/prompt.js')
			vi.mocked(isInteractiveEnvironment).mockReturnValue(true)
			vi.mocked(promptConfirmation).mockResolvedValue(false)

			vi.mocked(fetchChildIssues).mockResolvedValue([
				{ id: '101', title: 'Child 1', url: 'https://github.com/test/repo/issues/101', state: 'open' },
			])

			await epicCommand.execute({
				identifier: '100',
				options: {},
			})

			expect(fetchChildIssueDetails).not.toHaveBeenCalled()
			expect(buildDependencyMap).not.toHaveBeenCalled()
			expect(epicMockLoomManager.createIloom).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'issue',
				})
			)
		})

		it('should not fetch children for non-issue types (branch)', async () => {
			await epicCommand.execute({
				identifier: 'feature/my-branch',
				options: {},
			})

			expect(fetchChildIssues).not.toHaveBeenCalled()
		})

		it('should not fetch children for non-issue types (PR)', async () => {
			vi.mocked(epicMockGitHubService.fetchPR).mockResolvedValue({
				number: 50,
				title: 'Test PR',
				body: 'PR body',
				state: 'open',
				branch: 'feature-branch',
				baseBranch: 'main',
				url: 'https://github.com/test/repo/pull/50',
				isDraft: false,
			})
			vi.mocked(epicMockGitHubService.validatePRState).mockResolvedValue()

			await epicCommand.execute({
				identifier: 'pr/50',
				options: {},
			})

			expect(fetchChildIssues).not.toHaveBeenCalled()
		})
	})
})
