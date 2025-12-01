import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EnhanceCommand } from './enhance.js'
import type { GitHubService } from '../lib/GitHubService.js'
import type { AgentManager } from '../lib/AgentManager.js'
import type { SettingsManager, IloomSettings } from '../lib/SettingsManager.js'
import type { Issue } from '../types/index.js'
import { launchClaude } from '../utils/claude.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'

// Mock dependencies
vi.mock('../utils/claude.js')
vi.mock('../utils/browser.js')
vi.mock('../utils/prompt.js', () => ({
	waitForKeypress: vi.fn(),
	promptConfirmation: vi.fn(),
	promptInput: vi.fn(),
}))
vi.mock('../utils/mcp.js', () => ({
	generateIssueManagementMcpConfig: vi.fn().mockResolvedValue([]),
}))
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
}))

describe('EnhanceCommand', () => {
	let command: EnhanceCommand
	let mockGitHubService: GitHubService
	let mockAgentManager: AgentManager
	let mockSettingsManager: SettingsManager

	beforeEach(() => {
		// Create mock GitHubService
		mockGitHubService = {
			fetchIssue: vi.fn(),
			getIssueUrl: vi.fn(),
		} as unknown as GitHubService

		// Create mock AgentManager
		mockAgentManager = {
			loadAgents: vi.fn(),
			formatForCli: vi.fn(),
		} as unknown as AgentManager

		// Create mock SettingsManager
		mockSettingsManager = {
			loadSettings: vi.fn(),
		} as unknown as SettingsManager

		command = new EnhanceCommand(mockGitHubService, mockAgentManager, mockSettingsManager)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('input validation', () => {
		it('should throw error when issue number is missing', async () => {
			await expect(
				command.execute({ issueNumber: undefined as unknown as number, options: {} })
			).rejects.toThrow('Issue number is required')
		})

		it('should throw error when issue number is not a valid number', async () => {
			await expect(
				command.execute({ issueNumber: NaN, options: {} })
			).rejects.toThrow('Issue number must be a valid positive integer')
		})

		it('should throw error when issue number is negative', async () => {
			await expect(
				command.execute({ issueNumber: -5, options: {} })
			).rejects.toThrow('Issue number must be a valid positive integer')
		})

		it('should throw error when issue number is zero', async () => {
			await expect(
				command.execute({ issueNumber: 0, options: {} })
			).rejects.toThrow('Issue number must be a valid positive integer')
		})

		it('should accept valid positive issue numbers', async () => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()
		})
	})

	describe('issue fetching', () => {
		it('should fetch issue details using GitHubService', async () => {
			const mockIssue: Issue = {
				number: 123,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/123',
			}

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 123, options: {} })

			expect(mockGitHubService.fetchIssue).toHaveBeenCalledWith(123, undefined)
		})

		it('should throw error when issue does not exist', async () => {
			const error = new Error('Issue #999 not found')
			vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(error)

			await expect(
				command.execute({ issueNumber: 999, options: {} })
			).rejects.toThrow('Issue #999 not found')
		})

		it('should throw error when GitHub API fails', async () => {
			const error = new Error('GitHub API rate limit exceeded')
			vi.mocked(mockGitHubService.fetchIssue).mockRejectedValue(error)

			await expect(
				command.execute({ issueNumber: 123, options: {} })
			).rejects.toThrow('GitHub API rate limit exceeded')
		})
	})

	describe('agent invocation', () => {
		beforeEach(() => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
		})

		it('should load agents using AgentManager', async () => {
			const mockSettings = { agentPath: '/test/path' }
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue(mockSettings as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(mockSettings)
		})

		it('should construct correct prompt for orchestrating Claude instance', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('@agent-iloom-issue-enhancer 42'),
				expect.objectContaining({
					headless: true,
					model: 'sonnet',
				})
			)
		})

		it('should call launchClaude with headless mode', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ headless: true })
			)
		})

		it('should pass correct agents configuration to launchClaude', async () => {
			const mockAgents = { 'iloom-issue-enhancer': {} }
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue(mockAgents)

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ agents: mockAgents })
			)
		})

		it('should use sonnet model for Claude CLI', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ model: 'sonnet' })
			)
		})
	})

	describe('response parsing', () => {
		beforeEach(() => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})
		})

		it('should detect "No enhancement needed" response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			// Should not prompt for browser when no enhancement needed
			expect(waitForKeypress).not.toHaveBeenCalled()
		})

		it('should detect comment URL in response', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			// Should prompt for browser when enhancement occurred
			expect(waitForKeypress).toHaveBeenCalled()
		})

		it('should extract comment URL from response', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			// Verify URL is passed to browser opening (when not pressing 'q')
			expect(openBrowser).toHaveBeenCalledWith(commentUrl)
		})

		it('should handle malformed responses gracefully', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Some unexpected response format')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Unexpected response from enhancer agent')
		})

		it('should throw error on empty response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('No response from enhancer agent')
		})

		it('should detect and handle permission denied responses', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Permission denied: GitHub CLI not authenticated or not installed')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Permission denied: GitHub CLI not authenticated or not installed')
		})

		it('should handle permission denied with case insensitive matching', async () => {
			vi.mocked(launchClaude).mockResolvedValue('permission denied: Cannot access repository or issue does not exist')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Permission denied: Cannot access repository or issue does not exist')
		})

		it('should handle permission denied for comment creation', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Permission denied: Cannot create comments on this repository')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Permission denied: Cannot create comments on this repository')
		})

		it('should handle permission denied for API rate limits', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Permission denied: GitHub API rate limit exceeded')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Permission denied: GitHub API rate limit exceeded')
		})
	})

	describe('browser interaction', () => {
		beforeEach(() => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})
		})

		it('should not prompt for browser when no enhancement needed', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).not.toHaveBeenCalled()
		})

		it('should prompt "Press q to quit or any other key to view" when enhanced', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalledWith(
				expect.stringContaining('Press q to quit or any other key to view')
			)
		})

		it('should open browser when user does not press q', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(openBrowser).toHaveBeenCalledWith(commentUrl)
		})

		it('should NOT open browser when user presses q', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('q')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should NOT open browser when user presses Q (uppercase)', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('Q')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should skip browser when --no-browser flag is set', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)

			await command.execute({ issueNumber: 42, options: { noBrowser: true } })

			expect(waitForKeypress).not.toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should handle browser opening failures gracefully', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')
			vi.mocked(openBrowser).mockRejectedValue(new Error('Browser failed to open'))

			// Should not throw - browser failures are logged but not fatal
			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()
		})
	})

	describe('complete workflow', () => {
		it('should execute full enhancement workflow in correct order', async () => {
			const calls: string[] = []

			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}

			vi.mocked(mockGitHubService.fetchIssue).mockImplementation(async () => {
				calls.push('fetchIssue')
				return mockIssue
			})

			vi.mocked(mockSettingsManager.loadSettings).mockImplementation(async () => {
				calls.push('loadSettings')
				return {} as IloomSettings
			})

			vi.mocked(mockAgentManager.loadAgents).mockImplementation(async () => {
				calls.push('loadAgents')
				return []
			})

			vi.mocked(mockAgentManager.formatForCli).mockImplementation(() => {
				calls.push('formatForCli')
				return {}
			})

			vi.mocked(launchClaude).mockImplementation(async () => {
				calls.push('launchClaude')
				return 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			})

			vi.mocked(waitForKeypress).mockImplementation(async () => {
				calls.push('waitForKeypress')
				return 'a'
			})

			vi.mocked(openBrowser).mockImplementation(async () => {
				calls.push('openBrowser')
			})

			await command.execute({ issueNumber: 42, options: {} })

			expect(calls).toEqual([
				'loadSettings',
				'fetchIssue',
				'loadAgents',
				'formatForCli',
				'launchClaude',
				'waitForKeypress',
				'openBrowser',
			])
		})

		it('should handle idempotent case (no enhancement needed)', async () => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			// Should not open browser for idempotent case
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should handle enhancement case (comment created)', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})

			vi.mocked(launchClaude).mockResolvedValue(commentUrl)
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).toHaveBeenCalledWith(commentUrl)
		})
	})

	describe('author parameter support', () => {
		beforeEach(() => {
			const mockIssue: Issue = {
				number: 42,
				title: 'Test Issue',
				body: 'Test body',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			}
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue(mockIssue)
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue([])
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue({})
		})

		it('should include author in prompt when provided', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: { author: 'testuser' } })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('tag @testuser'),
				expect.any(Object)
			)
		})

		it('should not include author reference in prompt when not provided', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await command.execute({ issueNumber: 42, options: {} })

			const calledPrompt = vi.mocked(launchClaude).mock.calls[0][0]
			expect(calledPrompt).not.toContain('tag @')
		})

		it('should work without author parameter for backwards compatibility', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()
		})
	})
})
