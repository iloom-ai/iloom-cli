import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EnhanceCommand } from './enhance.js'
import type { GitHubService } from '../lib/GitHubService.js'
import type { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import type { SettingsManager, IloomSettings } from '../lib/SettingsManager.js'
import type { Issue } from '../types/index.js'
import { openBrowser } from '../utils/browser.js'
import { waitForKeypress } from '../utils/prompt.js'
import { processMarkdownImages } from '../utils/image-processor.js'

// Mock dependencies
vi.mock('../utils/browser.js')
vi.mock('../utils/image-processor.js', () => ({
	processMarkdownImages: vi.fn(),
}))
vi.mock('../utils/prompt.js', () => ({
	waitForKeypress: vi.fn(),
	promptConfirmation: vi.fn(),
	promptInput: vi.fn(),
}))
vi.mock('../utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn().mockResolvedValue(false),
	getConfiguredRepoFromSettings: vi.fn().mockResolvedValue('owner/repo'),
	parseGitRemotes: vi.fn().mockResolvedValue([]),
	validateConfiguredRemote: vi.fn().mockResolvedValue(undefined),
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
}))

describe('EnhanceCommand', () => {
	let command: EnhanceCommand
	let mockGitHubService: GitHubService
	let mockEnhancementService: IssueEnhancementService
	let mockSettingsManager: SettingsManager

	beforeEach(() => {
		// Create mock GitHubService
		mockGitHubService = {
			fetchIssue: vi.fn(),
			getIssueUrl: vi.fn(),
			providerName: 'github',
		} as unknown as GitHubService

		// Create mock IssueEnhancementService
		mockEnhancementService = {
			enhanceExistingIssue: vi.fn(),
		} as unknown as IssueEnhancementService

		// Create mock SettingsManager
		mockSettingsManager = {
			loadSettings: vi.fn(),
		} as unknown as SettingsManager

		command = new EnhanceCommand(mockGitHubService, mockEnhancementService, mockSettingsManager)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('first-run setup', () => {
		it('should trigger first-run setup when needsFirstRunSetup returns true', async () => {
			const { needsFirstRunSetup, launchFirstRunSetup } = await import(
				'../utils/first-run-setup.js'
			)
			vi.mocked(needsFirstRunSetup).mockResolvedValue(true)

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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			expect(needsFirstRunSetup).toHaveBeenCalled()
			expect(launchFirstRunSetup).toHaveBeenCalled()
		})

		it('should continue normally when needsFirstRunSetup returns false', async () => {
			const { needsFirstRunSetup, launchFirstRunSetup } = await import(
				'../utils/first-run-setup.js'
			)
			vi.mocked(needsFirstRunSetup).mockResolvedValue(false)

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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			expect(needsFirstRunSetup).toHaveBeenCalled()
			expect(launchFirstRunSetup).not.toHaveBeenCalled()
		})

		it('should trigger first-run setup when FORCE_FIRST_TIME_SETUP env var is true', async () => {
			const { launchFirstRunSetup } = await import(
				'../utils/first-run-setup.js'
			)
			const originalEnv = process.env.FORCE_FIRST_TIME_SETUP
			process.env.FORCE_FIRST_TIME_SETUP = 'true'

			try {
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
				vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

				await command.execute({ issueNumber: 42, options: {} })

				expect(launchFirstRunSetup).toHaveBeenCalled()
			} finally {
				process.env.FORCE_FIRST_TIME_SETUP = originalEnv
			}
		})
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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

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

	describe('enhancement service invocation', () => {
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

		it('should invoke enhancement service with issue number', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			expect(mockEnhancementService.enhanceExistingIssue).toHaveBeenCalledWith(
				42,
				{} // Empty object when no author or repo provided
			)
		})

		it('should pass author to enhancement service when provided', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: { author: 'testuser' } })

			expect(mockEnhancementService.enhanceExistingIssue).toHaveBeenCalledWith(
				42,
				expect.objectContaining({
					author: 'testuser',
				})
			)
		})
	})

	describe('response handling', () => {
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
		})

		it('should not prompt for browser when no enhancement needed', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			// Should not prompt for browser when no enhancement needed
			expect(waitForKeypress).not.toHaveBeenCalled()
		})

		it('should prompt for browser when enhancement occurred', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			// Should prompt for browser when enhancement occurred
			expect(waitForKeypress).toHaveBeenCalled()
		})

		it('should propagate errors from enhancement service', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockRejectedValue(
				new Error('No response from enhancer agent')
			)

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('No response from enhancer agent')
		})

		it('should propagate permission denied errors from enhancement service', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockRejectedValue(
				new Error('Permission denied: GitHub CLI not authenticated or not installed')
			)

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).rejects.toThrow('Permission denied: GitHub CLI not authenticated or not installed')
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
		})

		it('should not prompt for browser when no enhancement needed', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).not.toHaveBeenCalled()
		})

		it('should prompt "Press q to quit or any other key to view" when enhanced', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalledWith(
				expect.stringContaining('Press q to quit or any other key to view')
			)
		})

		it('should open browser when user does not press q', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(openBrowser).toHaveBeenCalledWith(commentUrl)
		})

		it('should NOT open browser when user presses q', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('q')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should NOT open browser when user presses Q (uppercase)', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('Q')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should skip browser when --no-browser flag is set', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })

			await command.execute({ issueNumber: 42, options: { noBrowser: true } })

			expect(waitForKeypress).not.toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should handle browser opening failures gracefully', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
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

			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockImplementation(async () => {
				calls.push('enhanceExistingIssue')
				return { enhanced: true, url: 'https://github.com/owner/repo/issues/42#issuecomment-123456' }
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
				'enhanceExistingIssue',
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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

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
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })
			vi.mocked(waitForKeypress).mockResolvedValue('a')

			await command.execute({ issueNumber: 42, options: {} })

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).toHaveBeenCalledWith(commentUrl)
		})
	})

	describe('--json flag behavior', () => {
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
		})

		it('should return EnhanceResult object when json option is true and enhancement occurred', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })

			const result = await command.execute({ issueNumber: 42, options: { json: true } })

			expect(result).toEqual(expect.objectContaining({
				url: commentUrl,
				id: 123456,
				title: 'Test Issue',
				enhanced: true,
			}))
			expect(result).toHaveProperty('created_at')
		})

		it('should return EnhanceResult with enhanced=false when no enhancement needed', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			const result = await command.execute({ issueNumber: 42, options: { json: true } })

			expect(result).toEqual(expect.objectContaining({
				url: 'https://github.com/owner/repo/issues/42',
				id: 0,
				title: 'Test Issue',
				enhanced: false,
			}))
		})

		it('should skip browser interaction when json option is true', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })

			await command.execute({ issueNumber: 42, options: { json: true } })

			expect(waitForKeypress).not.toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should return void when json option is not set', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			const result = await command.execute({ issueNumber: 42, options: {} })

			expect(result).toBeUndefined()
		})

		it('should skip first-run setup in json mode', async () => {
			const { needsFirstRunSetup, launchFirstRunSetup } = await import(
				'../utils/first-run-setup.js'
			)
			vi.mocked(needsFirstRunSetup).mockResolvedValue(true)
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: { json: true } })

			expect(launchFirstRunSetup).not.toHaveBeenCalled()
		})

		it('should extract comment ID from URL correctly', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-999888777'
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: true, url: commentUrl })

			const result = await command.execute({ issueNumber: 42, options: { json: true } })

			expect(result).toHaveProperty('id', 999888777)
		})

		it('should include created_at as ISO timestamp', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			const result = await command.execute({ issueNumber: 42, options: { json: true } })

			expect(result).toBeDefined()
			if (result) {
				expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
			}
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
		})

		it('should pass author to enhancement service when provided', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: { author: 'testuser' } })

			expect(mockEnhancementService.enhanceExistingIssue).toHaveBeenCalledWith(
				42,
				expect.objectContaining({
					author: 'testuser',
				})
			)
		})

		it('should not include author when not provided', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await command.execute({ issueNumber: 42, options: {} })

			// When no author is provided, the options object should not contain author key
			const call = vi.mocked(mockEnhancementService.enhanceExistingIssue).mock.calls[0]
			expect(call[0]).toBe(42)
			expect(call[1]).not.toHaveProperty('author')
		})

		it('should work without author parameter for backwards compatibility', async () => {
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()
		})
	})

	describe('image processing', () => {
		beforeEach(() => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({} as IloomSettings)
			vi.mocked(mockEnhancementService.enhanceExistingIssue).mockResolvedValue({ enhanced: false })
		})

		it('should rewrite image URLs for Linear-provider issue bodies', async () => {
			const linearService = {
				fetchIssue: vi.fn(),
				providerName: 'linear',
			} as unknown as GitHubService
			const linearCommand = new EnhanceCommand(linearService, mockEnhancementService, mockSettingsManager)

			const originalBody = 'See ![mockup](https://uploads.linear.app/abc/foo.png)'
			const rewrittenBody = 'See ![mockup](/tmp/iloom-images/abc.png)'

			vi.mocked(linearService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: originalBody,
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://linear.app/team/issue/TEAM-42',
			} as Issue)

			vi.mocked(processMarkdownImages).mockResolvedValue(rewrittenBody)

			await linearCommand.execute({ issueNumber: 42, options: {} })

			expect(processMarkdownImages).toHaveBeenCalledWith(originalBody, 'linear')
		})

		it('should rewrite image URLs for GitHub-provider issue bodies', async () => {
			const originalBody = 'Screenshot ![](https://private-user-images.githubusercontent.com/x/y.png)'
			const rewrittenBody = 'Screenshot ![](/tmp/iloom-images/y.png)'

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: originalBody,
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			} as Issue)

			vi.mocked(processMarkdownImages).mockResolvedValue(rewrittenBody)

			await command.execute({ issueNumber: 42, options: {} })

			expect(processMarkdownImages).toHaveBeenCalledWith(originalBody, 'github')
		})

		it('should pass through bodies with no images unchanged', async () => {
			const plainBody = 'Just some text with no images.'

			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: plainBody,
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			} as Issue)

			// processMarkdownImages returns the content unchanged when no images exist
			vi.mocked(processMarkdownImages).mockResolvedValue(plainBody)

			await expect(
				command.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()

			expect(processMarkdownImages).toHaveBeenCalledWith(plainBody, 'github')
		})

		it('should fall back to the original body when image processing throws', async () => {
			const originalBody = '![img](https://uploads.linear.app/abc/foo.png)'

			const linearService = {
				fetchIssue: vi.fn(),
				providerName: 'linear',
			} as unknown as GitHubService
			const linearCommand = new EnhanceCommand(linearService, mockEnhancementService, mockSettingsManager)

			vi.mocked(linearService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: originalBody,
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://linear.app/team/issue/TEAM-42',
			} as Issue)

			vi.mocked(processMarkdownImages).mockRejectedValue(new Error('network failure'))

			// Should not throw - fall back to original body
			await expect(
				linearCommand.execute({ issueNumber: 42, options: {} })
			).resolves.not.toThrow()

			expect(processMarkdownImages).toHaveBeenCalledWith(originalBody, 'linear')
		})

		it('should skip image processing for unsupported providers (e.g. jira)', async () => {
			const jiraService = {
				fetchIssue: vi.fn(),
				providerName: 'jira',
			} as unknown as GitHubService
			const jiraCommand = new EnhanceCommand(jiraService, mockEnhancementService, mockSettingsManager)

			vi.mocked(jiraService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: 'Body with image',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://example.atlassian.net/browse/PROJ-42',
			} as Issue)

			await jiraCommand.execute({ issueNumber: 42, options: {} })

			expect(processMarkdownImages).not.toHaveBeenCalled()
		})

		it('should skip image processing when issue body is empty', async () => {
			vi.mocked(mockGitHubService.fetchIssue).mockResolvedValue({
				number: 42,
				title: 'Test Issue',
				body: '',
				state: 'open',
				labels: [],
				assignees: [],
				url: 'https://github.com/owner/repo/issues/42',
			} as Issue)

			await command.execute({ issueNumber: 42, options: {} })

			expect(processMarkdownImages).not.toHaveBeenCalled()
		})
	})
})
