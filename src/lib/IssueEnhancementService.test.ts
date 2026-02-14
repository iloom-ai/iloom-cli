import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IssueEnhancementService } from './IssueEnhancementService.js'
import { GitHubService } from './GitHubService.js'
import { AgentManager } from './AgentManager.js'
import { SettingsManager } from './SettingsManager.js'
import { openBrowser } from '../utils/browser.js'
import { launchClaude } from '../utils/claude.js'
import { logger } from '../utils/logger.js'
import { waitForKeypress } from '../utils/prompt.js'

// Mock dependencies
vi.mock('./GitHubService.js')
vi.mock('./AgentManager.js')
vi.mock('./SettingsManager.js')

// Mock utilities
vi.mock('../utils/claude.js', () => ({
	launchClaude: vi.fn(),
}))

vi.mock('../utils/browser.js', () => ({
	openBrowser: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../utils/prompt.js', () => ({
	waitForKeypress: vi.fn().mockResolvedValue('a'),
}))

vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

vi.mock('../utils/mcp.js', () => ({
	generateIssueManagementMcpConfig: vi.fn().mockResolvedValue([]),
}))

describe('IssueEnhancementService', () => {
	let service: IssueEnhancementService
	let mockGitHubService: GitHubService
	let mockAgentManager: AgentManager
	let mockSettingsManager: SettingsManager

	beforeEach(() => {
		mockGitHubService = new GitHubService()
		mockAgentManager = new AgentManager()
		mockSettingsManager = new SettingsManager()

		// Mock formatIssueId to return GitHub-style formatting
		vi.mocked(mockGitHubService.formatIssueId).mockImplementation((id) => `#${id}`)

		service = new IssueEnhancementService(
			mockGitHubService,
			mockAgentManager,
			mockSettingsManager
		)
	})


	describe('validateDescription', () => {
		describe('without hasBody (standard validation)', () => {
			it('should return true for valid descriptions (>30 chars AND >2 spaces)', () => {
				const validDescription = 'This is a valid description that has more than fifty characters and multiple spaces'
				expect(service.validateDescription(validDescription)).toBe(true)
			})

			it('should return false for short descriptions (<30 chars)', () => {
				const shortDescription = 'Short description with spaces'
				expect(service.validateDescription(shortDescription)).toBe(false)
			})

			it('should return false for descriptions with <=2 spaces', () => {
				const noSpaces = 'Thisisareallylongdescriptionwithoutanyspacesatallbutmorethanfiftycharacters'
				const oneSpace = 'This hasonespaceonlybutmorethanfiftycharactersintotaltocountwithvalidation'
				const twoSpaces = 'This has twospacesbutmorethanfiftycharactersintotaltocountwithvalidation'

				expect(service.validateDescription(noSpaces)).toBe(false)
				expect(service.validateDescription(oneSpace)).toBe(false)
				expect(service.validateDescription(twoSpaces)).toBe(false)
			})

			it('should trim description before validation', () => {
				const validWithWhitespace = '   This is a valid description that has more than fifty characters and multiple spaces   '
				expect(service.validateDescription(validWithWhitespace)).toBe(true)
			})
		})

		describe('with hasBody=true (relaxed validation)', () => {
			it('should return true for any non-empty description', () => {
				expect(service.validateDescription('fix', true)).toBe(true)
				expect(service.validateDescription('x', true)).toBe(true)
				expect(service.validateDescription('short', true)).toBe(true)
				expect(service.validateDescription('a single word', true)).toBe(true)
			})

			it('should return false for empty descriptions', () => {
				expect(service.validateDescription('', true)).toBe(false)
			})

			it('should return false for whitespace-only descriptions', () => {
				expect(service.validateDescription('   ', true)).toBe(false)
				expect(service.validateDescription('\t\n', true)).toBe(false)
			})

			it('should accept short descriptions that would fail standard validation', () => {
				// These fail without hasBody
				expect(service.validateDescription('short')).toBe(false)
				expect(service.validateDescription('no spaces here')).toBe(false)

				// Same descriptions pass with hasBody=true
				expect(service.validateDescription('short', true)).toBe(true)
				expect(service.validateDescription('no spaces here', true)).toBe(true)
			})
		})
	})

	describe('enhanceDescription', () => {
		beforeEach(() => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				agents: {},
			})
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue({
				'iloom-issue-enhancer': {
					description: 'Test agent',
					prompt: 'Test prompt',
					tools: [],
					model: 'sonnet',
				},
			})
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue('agent1=path1')
		})

		it('should call Claude with correct prompt format', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Enhanced description')

			const description = 'Original description that needs enhancement'
			await service.enhanceDescription(description)

			expect(launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('@agent-iloom-issue-enhancer'),
				expect.objectContaining({
					headless: true,
					model: 'sonnet',
					agents: 'agent1=path1',
				})
			)

			// Verify prompt structure
			const calledPrompt = vi.mocked(launchClaude).mock.calls[0][0]
			expect(calledPrompt).toContain('TASK:')
			expect(calledPrompt).toContain('OUTPUT REQUIREMENTS:')
			expect(calledPrompt).toContain('NO meta-commentary')
			expect(calledPrompt).not.toMatch(/^ask @agent/i)
		})

		it('should load and pass agent configurations', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Enhanced description')

			await service.enhanceDescription('Test description with enough length and spaces')

			expect(mockSettingsManager.loadSettings).toHaveBeenCalled()
			expect(mockAgentManager.loadAgents).toHaveBeenCalled()
			expect(mockAgentManager.formatForCli).toHaveBeenCalled()
		})

		it('should return enhanced description on success', async () => {
			const enhancedText = 'This is the enhanced description from Claude'
			vi.mocked(launchClaude).mockResolvedValue(enhancedText)

			const result = await service.enhanceDescription('Original description with enough length and spaces')
			expect(result).toBe(enhancedText)
		})

		it('should return original description when Claude returns empty/null', async () => {
			const originalDescription = 'Original description with enough length and spaces'

			vi.mocked(launchClaude).mockResolvedValue('')
			let result = await service.enhanceDescription(originalDescription)
			expect(result).toBe(originalDescription)

			vi.mocked(launchClaude).mockResolvedValue(null)
			result = await service.enhanceDescription(originalDescription)
			expect(result).toBe(originalDescription)
		})

		it('should return original description when Claude throws error', async () => {
			const originalDescription = 'Original description with enough length and spaces'

			vi.mocked(launchClaude).mockRejectedValue(new Error('Claude API error'))

			const result = await service.enhanceDescription(originalDescription)
			expect(result).toBe(originalDescription)
		})

		it('should log appropriate messages for each scenario', async () => {
			const originalDescription = 'Original description with enough length and spaces'

			// Success scenario
			vi.mocked(launchClaude).mockResolvedValue('Enhanced')
			await service.enhanceDescription(originalDescription)
			expect(logger.success).toHaveBeenCalledWith('Description enhanced successfully')

			// Empty result scenario
			vi.mocked(launchClaude).mockResolvedValue('')
			await service.enhanceDescription(originalDescription)
			expect(logger.warn).toHaveBeenCalledWith('Claude enhancement returned empty result, using original description')

			// Error scenario
			vi.mocked(launchClaude).mockRejectedValue(new Error('Test error'))
			await service.enhanceDescription(originalDescription)
			expect(logger.warn).toHaveBeenCalledWith('Failed to enhance description: Test error')
		})

		it('should handle enhanced content that starts directly with markdown', async () => {
			const enhancedContent = '## Enhancement Request\n\nAdd dark mode support'
			vi.mocked(launchClaude).mockResolvedValue(enhancedContent)

			const result = await service.enhanceDescription('need dark mode')

			// Should start with the actual content, not conversational text
			expect(result).toMatch(/^##/)
			expect(result).not.toMatch(/^(here|the|i)/i)
		})

		it('should call launchClaude with non-conversational prompt', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Enhanced')

			await service.enhanceDescription('Test description with enough length and spaces')

			const calledPrompt = vi.mocked(launchClaude).mock.calls[0][0]

			// Should NOT use conversational framing
			expect(calledPrompt).not.toMatch(/^ask @agent/i)

			// Should include explicit output constraints
			expect(calledPrompt).toMatch(/ONLY|DO NOT|NO meta/i)

			// Should reference the agent directly
			expect(calledPrompt).toMatch(/@agent-iloom-issue-enhancer/)
		})
	})

	describe('createEnhancedIssue', () => {
		it('should create issue with original description as title', async () => {
			const originalDescription = 'Original description'
			const enhancedDescription = 'Enhanced description with details'

			vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
				number: 123,
				url: 'https://github.com/owner/repo/issues/123',
			})

			await service.createEnhancedIssue(originalDescription, enhancedDescription)

			expect(mockGitHubService.createIssue).toHaveBeenCalledWith(
				originalDescription,
				enhancedDescription,
				undefined,
				undefined
			)
		})

		it('should use enhanced description as body', async () => {
			const originalDescription = 'Original description'
			const enhancedDescription = 'Enhanced description with details'

			vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
				number: 123,
				url: 'https://github.com/owner/repo/issues/123',
			})

			await service.createEnhancedIssue(originalDescription, enhancedDescription)

			const call = vi.mocked(mockGitHubService.createIssue).mock.calls[0]
			expect(call[1]).toBe(enhancedDescription)
		})

		it('should return issue number and URL', async () => {
			const expectedResult = {
				number: 456,
				url: 'https://github.com/owner/repo/issues/456',
			}

			vi.mocked(mockGitHubService.createIssue).mockResolvedValue(expectedResult)

			const result = await service.createEnhancedIssue('Original', 'Enhanced')

			expect(result).toEqual(expectedResult)
		})

		it('should call GitHubService.createIssue once', async () => {
			vi.mocked(mockGitHubService.createIssue).mockResolvedValue({
				number: 123,
				url: 'https://github.com/owner/repo/issues/123',
			})

			await service.createEnhancedIssue('Original', 'Enhanced')

			expect(mockGitHubService.createIssue).toHaveBeenCalledTimes(1)
		})
	})

	describe('waitForReviewAndOpen', () => {
		let originalCIValue: string | undefined
		let originalIsTTY: boolean | undefined

		beforeEach(() => {
			// Save and remove CI environment variable to test normal interactive behavior
			originalCIValue = process.env.CI
			delete process.env.CI
			// Save and set isTTY to simulate interactive environment
			originalIsTTY = process.stdin.isTTY
			Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
		})

		afterEach(() => {
			// Restore original CI environment variable
			if (originalCIValue === undefined) {
				delete process.env.CI
			} else {
				process.env.CI = originalCIValue
			}
			// Restore original isTTY value
			Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
		})

		describe('with confirm=false (default, single keypress)', () => {
			it('should fetch issue URL using GitHubService', async () => {
				const issueNumber = 123
				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				await service.waitForReviewAndOpen(issueNumber)

				expect(mockGitHubService.getIssueUrl).toHaveBeenCalledWith(issueNumber, undefined)
			})

			it('should wait for keypress before opening browser', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				// Track call order
				const calls: string[] = []
				vi.mocked(waitForKeypress).mockImplementation(async () => {
					calls.push('keypress')
				})
				vi.mocked(openBrowser).mockImplementation(async () => {
					calls.push('browser')
				})

				await service.waitForReviewAndOpen(123)

				// First keypress should happen before browser opens
				expect(calls[0]).toBe('keypress')
				expect(calls[1]).toBe('browser')
			})

			it('should open browser with correct URL', async () => {
				const issueUrl = 'https://github.com/owner/repo/issues/123'

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue(issueUrl)

				await service.waitForReviewAndOpen(123)

				expect(openBrowser).toHaveBeenCalledWith(issueUrl)
			})

			it('should wait for keypress only once when confirm=false', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				await service.waitForReviewAndOpen(123, false)

				// Should be called once - before opening browser
				expect(waitForKeypress).toHaveBeenCalledTimes(1)
			})

			it('should handle errors gracefully', async () => {
				vi.mocked(mockGitHubService.getIssueUrl).mockRejectedValue(new Error('Network error'))

				await expect(service.waitForReviewAndOpen(123)).rejects.toThrow('Network error')
			})
		})

		describe('with confirm=true (double keypress)', () => {
			it('should wait for first keypress before opening browser', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				// Track call order
				const calls: string[] = []
				vi.mocked(waitForKeypress).mockImplementation(async () => {
					calls.push('keypress')
				})
				vi.mocked(openBrowser).mockImplementation(async () => {
					calls.push('browser')
				})

				await service.waitForReviewAndOpen(123, true)

				// First keypress should happen before browser opens
				expect(calls[0]).toBe('keypress')
				expect(calls[1]).toBe('browser')
			})

			it('should open browser with correct issue URL', async () => {
				const issueUrl = 'https://github.com/owner/repo/issues/456'

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue(issueUrl)

				await service.waitForReviewAndOpen(456, true)

				expect(openBrowser).toHaveBeenCalledWith(issueUrl)
			})

			it('should wait for second keypress after opening browser', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				// Track call order
				const calls: string[] = []
				vi.mocked(waitForKeypress).mockImplementation(async () => {
					calls.push('keypress')
				})
				vi.mocked(openBrowser).mockImplementation(async () => {
					calls.push('browser')
				})

				await service.waitForReviewAndOpen(123, true)

				// Second keypress should happen after browser opens
				expect(calls[2]).toBe('keypress')
			})

			it('should call waitForKeypress exactly twice in correct order', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				// Track call order
				const calls: string[] = []
				vi.mocked(mockGitHubService.getIssueUrl).mockImplementation(async () => {
					calls.push('getIssueUrl')
					return 'https://github.com/owner/repo/issues/123'
				})
				vi.mocked(waitForKeypress).mockImplementation(async () => {
					calls.push('waitForKeypress')
				})
				vi.mocked(openBrowser).mockImplementation(async () => {
					calls.push('openBrowser')
				})

				await service.waitForReviewAndOpen(123, true)

				// Verify call order: getIssueUrl -> waitForKeypress (1st) -> openBrowser -> waitForKeypress (2nd)
				expect(calls).toEqual(['getIssueUrl', 'waitForKeypress', 'openBrowser', 'waitForKeypress'])
				expect(waitForKeypress).toHaveBeenCalledTimes(2)
			})

			it('should pass appropriate messages to waitForKeypress', async () => {

				vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

				await service.waitForReviewAndOpen(123, true)

				// Check that first waitForKeypress is called with multi-line message
				const firstCall = vi.mocked(waitForKeypress).mock.calls[0][0]
				expect(firstCall).toContain('Created issue #123.')
				expect(firstCall).toContain('Review and edit the issue in your browser if needed.')
				expect(firstCall).toContain('Press any key to open issue for editing...')

				// Check that second waitForKeypress is called with confirmation message
				expect(waitForKeypress).toHaveBeenNthCalledWith(2, 'Press any key to continue with loom creation...')
			})

			it('should handle errors gracefully', async () => {
				vi.mocked(mockGitHubService.getIssueUrl).mockRejectedValue(new Error('Network error'))

				await expect(service.waitForReviewAndOpen(123, true)).rejects.toThrow('Network error')
			})
		})
	})

	describe('waitForReviewAndOpen CI behavior', () => {
		let originalCIValue: string | undefined
		let originalIsTTY: boolean | undefined

		beforeEach(() => {
			// Save original CI environment variable
			originalCIValue = process.env.CI
			// Save and set isTTY to simulate interactive environment for non-CI tests
			originalIsTTY = process.stdin.isTTY
			Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
		})

		afterEach(() => {
			// Restore original CI environment variable
			if (originalCIValue === undefined) {
				delete process.env.CI
			} else {
				process.env.CI = originalCIValue
			}
			// Restore original isTTY value
			Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
		})

		it('should skip keypress and browser when CI=true', async () => {
			process.env.CI = 'true'

			vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

			await service.waitForReviewAndOpen(123)

			expect(waitForKeypress).not.toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})

		it('should perform normal flow when CI is not set', async () => {
			delete process.env.CI

			vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

			await service.waitForReviewAndOpen(123)

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).toHaveBeenCalled()
		})

		it('should perform normal flow when CI is false', async () => {
			process.env.CI = 'false'

			vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

			await service.waitForReviewAndOpen(123)

			expect(waitForKeypress).toHaveBeenCalled()
			expect(openBrowser).toHaveBeenCalled()
		})

		it('should skip keypress and browser when not a TTY', async () => {
			delete process.env.CI
			Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

			vi.mocked(mockGitHubService.getIssueUrl).mockResolvedValue('https://github.com/owner/repo/issues/123')

			await service.waitForReviewAndOpen(123)

			expect(waitForKeypress).not.toHaveBeenCalled()
			expect(openBrowser).not.toHaveBeenCalled()
		})
	})

	describe('enhanceExistingIssue', () => {
		beforeEach(() => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				agents: {},
			})
			vi.mocked(mockAgentManager.loadAgents).mockResolvedValue({
				'iloom-issue-enhancer': {
					description: 'Test agent',
					prompt: 'Test prompt',
					tools: [],
					model: 'sonnet',
				},
			})
			vi.mocked(mockAgentManager.formatForCli).mockReturnValue('agent1=path1')
			// Mock providerName
			Object.defineProperty(mockGitHubService, 'providerName', { value: 'github', configurable: true })
		})

		it('should invoke Claude with correct prompt and MCP config', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await service.enhanceExistingIssue(42)

			expect(launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('@agent-iloom-issue-enhancer 42'),
				expect.objectContaining({
					headless: true,
					model: 'sonnet',
					agents: 'agent1=path1',
					noSessionPersistence: true,
				})
			)
		})

		it('should return { enhanced: false } for "No enhancement needed" response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			const result = await service.enhanceExistingIssue(42)

			expect(result).toEqual({ enhanced: false })
		})

		it('should return { enhanced: true, url } for valid comment URL response', async () => {
			const commentUrl = 'https://github.com/owner/repo/issues/42#issuecomment-123456'
			vi.mocked(launchClaude).mockResolvedValue(commentUrl)

			const result = await service.enhanceExistingIssue(42)

			expect(result).toEqual({ enhanced: true, url: commentUrl })
		})

		it('should throw on empty response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('')

			await expect(service.enhanceExistingIssue(42)).rejects.toThrow('No response from enhancer agent')
		})

		it('should throw on permission denied responses', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Permission denied: GitHub CLI not authenticated')

			await expect(service.enhanceExistingIssue(42)).rejects.toThrow('Permission denied: GitHub CLI not authenticated')
		})

		it('should throw on malformed responses', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Some unexpected response format')

			await expect(service.enhanceExistingIssue(42)).rejects.toThrow('Unexpected response from enhancer agent')
		})

		it('should include author tag in prompt when author provided', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await service.enhanceExistingIssue(42, { author: 'testuser' })

			expect(launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('tag @testuser'),
				expect.any(Object)
			)
		})

		it('should not include author tag when author not provided', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await service.enhanceExistingIssue(42)

			const calledPrompt = vi.mocked(launchClaude).mock.calls[0][0]
			expect(calledPrompt).not.toContain('tag @')
		})

		it('should pass MCP config and tool filtering to launchClaude', async () => {
			vi.mocked(launchClaude).mockResolvedValue('No enhancement needed')

			await service.enhanceExistingIssue(42)

			expect(launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					allowedTools: [
						'mcp__issue_management__get_issue',
						'mcp__issue_management__get_comment',
						'mcp__issue_management__create_comment',
						'mcp__issue_management__update_comment',
						'mcp__issue_management__create_issue',
					],
					disallowedTools: ['Bash(gh api:*)'],
				})
			)
		})

		it('should handle case-insensitive "No enhancement needed" response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('no enhancement needed')

			const result = await service.enhanceExistingIssue(42)

			expect(result).toEqual({ enhanced: false })
		})

		it('should handle case-insensitive permission denied response', async () => {
			vi.mocked(launchClaude).mockResolvedValue('permission denied: Cannot access repository')

			await expect(service.enhanceExistingIssue(42)).rejects.toThrow('Permission denied: Cannot access repository')
		})

		it('should extract URL from response containing extra text', async () => {
			const response = 'Some text before https://github.com/owner/repo/issues/42#issuecomment-123456 and after'
			vi.mocked(launchClaude).mockResolvedValue(response)

			const result = await service.enhanceExistingIssue(42)

			expect(result).toEqual({ enhanced: true, url: 'https://github.com/owner/repo/issues/42#issuecomment-123456' })
		})
	})
})
