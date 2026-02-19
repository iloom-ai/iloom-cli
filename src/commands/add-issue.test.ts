import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AddIssueCommand } from './add-issue.js'
import { IssueEnhancementService } from '../lib/IssueEnhancementService.js'
import type { GitHubService } from '../lib/GitHubService.js'
import type { AgentManager } from '../lib/AgentManager.js'
import type { SettingsManager } from '../lib/SettingsManager.js'

// Mock dependencies
vi.mock('../lib/IssueEnhancementService.js')
vi.mock('../lib/SettingsManager.js', () => {
	return {
		SettingsManager: class MockSettingsManager {
			async loadSettings() {
				return {}
			}
		},
	}
})

// Mock remote utilities
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

describe('AddIssueCommand', () => {
	let command: AddIssueCommand
	let mockEnhancementService: IssueEnhancementService

	beforeEach(() => {
		const mockIssueTracker = { providerName: 'github' } as GitHubService
		mockEnhancementService = new IssueEnhancementService(
			mockIssueTracker,
			{} as AgentManager,
			{} as SettingsManager
		)
		// Override the issueTracker getter to ensure it returns our mock
		Object.defineProperty(mockEnhancementService, 'issueTracker', {
			get: () => mockIssueTracker,
		})
		command = new AddIssueCommand(mockEnhancementService)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('execute', () => {
		const validDescription = 'This is a valid description that has more than thirty characters and multiple spaces'

		describe('first-run setup', () => {
			it('should trigger first-run setup when needsFirstRunSetup returns true', async () => {
				const { needsFirstRunSetup, launchFirstRunSetup } = await import(
					'../utils/first-run-setup.js'
				)
				vi.mocked(needsFirstRunSetup).mockResolvedValue(true)
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				expect(needsFirstRunSetup).toHaveBeenCalled()
				expect(launchFirstRunSetup).toHaveBeenCalled()
			})

			it('should continue normally when needsFirstRunSetup returns false', async () => {
				const { needsFirstRunSetup, launchFirstRunSetup } = await import(
					'../utils/first-run-setup.js'
				)
				vi.mocked(needsFirstRunSetup).mockResolvedValue(false)
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

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
					vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
					vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
					vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
						number: 123,
						url: 'https://github.com/owner/repo/issues/123',
					})
					vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

					await command.execute({ description: validDescription, options: {} })

					expect(launchFirstRunSetup).toHaveBeenCalled()
				} finally {
					process.env.FORCE_FIRST_TIME_SETUP = originalEnv
				}
			})
		})

		describe('input validation', () => {
			it('should throw error when description is empty or missing', async () => {
				await expect(
					command.execute({ description: '', options: {} })
				).rejects.toThrow('Description is required and must be more than 30 characters with at least 3 words')
			})

			it('should throw error when description is too short (<30 chars)', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(false)

				await expect(
					command.execute({ description: 'Short description', options: {} })
				).rejects.toThrow('Description is required and must be more than 30 characters with at least 3 words')
			})

			it('should throw error when description has insufficient spaces (<=2)', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(false)

				await expect(
					command.execute({ description: 'This has twospacesbutmorethanthirtycharactersintotal', options: {} })
				).rejects.toThrow('Description is required and must be more than 30 characters with at least 3 words')
			})

			it('should accept valid descriptions (>30 chars AND >2 spaces)', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await expect(
					command.execute({ description: validDescription, options: {} })
				).resolves.toBe(123)
			})
		})

		describe('enhancement workflow', () => {
			beforeEach(() => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
			})

			it('should enhance description using IssueEnhancementService', async () => {
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				expect(mockEnhancementService.enhanceDescription).toHaveBeenCalledWith(validDescription)
			})

			it('should use original description as title and enhanced version as body', async () => {
				const enhancedDescription = 'This is the enhanced description with more details and structure'
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue(enhancedDescription)
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				expect(mockEnhancementService.createEnhancedIssue).toHaveBeenCalledWith(
					validDescription,
					enhancedDescription,
					undefined
				)
			})

			it('should handle enhancement failures gracefully', async () => {
				// Enhancement returns original description on failure
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue(validDescription)
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await expect(
					command.execute({ description: validDescription, options: {} })
				).resolves.toBe(123)
			})
		})

		describe('GitHub integration', () => {
			beforeEach(() => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
			})

			it('should call createEnhancedIssue with correct parameters', async () => {
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 456,
					url: 'https://github.com/owner/repo/issues/456',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				expect(mockEnhancementService.createEnhancedIssue).toHaveBeenCalledTimes(1)
			})

			it('should return the created issue number', async () => {
				const expectedIssueNumber = 789
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: expectedIssueNumber,
					url: 'https://github.com/owner/repo/issues/789',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				const result = await command.execute({ description: validDescription, options: {} })

				expect(result).toBe(expectedIssueNumber)
			})

			it('should propagate errors from createEnhancedIssue', async () => {
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockRejectedValue(
					new Error('GitHub API error')
				)

				await expect(
					command.execute({ description: validDescription, options: {} })
				).rejects.toThrow('GitHub API error')
			})
		})

		describe('browser interaction', () => {
			beforeEach(() => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
			})

			it('should call waitForReviewAndOpen with confirm=false (single keypress)', async () => {
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				// add-issue should use single keypress method (confirm=false is default)
				expect(mockEnhancementService.waitForReviewAndOpen).toHaveBeenCalledWith(123)
				expect(mockEnhancementService.waitForReviewAndOpen).toHaveBeenCalledTimes(1)
			})

			it('should wait for review and open browser', async () => {
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)

				await command.execute({ description: validDescription, options: {} })

				expect(mockEnhancementService.waitForReviewAndOpen).toHaveBeenCalledWith(123)
			})

			it('should wait for review after issue creation', async () => {
				const calls: string[] = []

				vi.mocked(mockEnhancementService.createEnhancedIssue).mockImplementation(async () => {
					calls.push('create')
					return { number: 123, url: 'https://github.com/owner/repo/issues/123' }
				})

				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockImplementation(async () => {
					calls.push('review')
				})

				await command.execute({ description: validDescription, options: {} })

				expect(calls).toEqual(['create', 'review'])
			})

			it('should handle browser opening failures gracefully', async () => {
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockRejectedValue(
					new Error('Browser opening failed')
				)

				await expect(
					command.execute({ description: validDescription, options: {} })
				).rejects.toThrow('Browser opening failed')
			})
		})

		describe('complete workflow', () => {
			it('should execute full workflow in correct order', async () => {
				const calls: string[] = []

				vi.mocked(mockEnhancementService.validateDescription).mockImplementation(() => {
					calls.push('validate')
					return true
				})

				vi.mocked(mockEnhancementService.enhanceDescription).mockImplementation(async () => {
					calls.push('enhance')
					return 'Enhanced description'
				})

				vi.mocked(mockEnhancementService.createEnhancedIssue).mockImplementation(async () => {
					calls.push('create')
					return { number: 123, url: 'https://github.com/owner/repo/issues/123' }
				})

				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockImplementation(async () => {
					calls.push('review')
				})

				await command.execute({ description: validDescription, options: {} })

				expect(calls).toEqual(['validate', 'enhance', 'create', 'review'])
			})
		})

		describe('--json flag behavior', () => {
			const validDescription = 'This is a valid description that has more than thirty characters and multiple spaces'

			beforeEach(() => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)
			})

			it('should return AddIssueResult object when json option is true', async () => {
				const result = await command.execute({
					description: validDescription,
					options: { json: true }
				})

				expect(result).toEqual(expect.objectContaining({
					url: 'https://github.com/owner/repo/issues/123',
					id: 123,
					title: validDescription,
				}))
				expect(result).toHaveProperty('created_at')
			})

			it('should skip waitForReviewAndOpen when json option is true', async () => {
				await command.execute({
					description: validDescription,
					options: { json: true }
				})

				expect(mockEnhancementService.waitForReviewAndOpen).not.toHaveBeenCalled()
			})

			it('should still call waitForReviewAndOpen when json option is false', async () => {
				await command.execute({
					description: validDescription,
					options: { json: false }
				})

				expect(mockEnhancementService.waitForReviewAndOpen).toHaveBeenCalled()
			})

			it('should return issue number when json option is not set', async () => {
				const result = await command.execute({
					description: validDescription,
					options: {}
				})

				expect(result).toBe(123)
			})

			it('should skip first-run setup in json mode', async () => {
				const { needsFirstRunSetup, launchFirstRunSetup } = await import(
					'../utils/first-run-setup.js'
				)
				vi.mocked(needsFirstRunSetup).mockResolvedValue(true)

				await command.execute({
					description: validDescription,
					options: { json: true }
				})

				expect(launchFirstRunSetup).not.toHaveBeenCalled()
			})

			it('should include created_at as ISO timestamp', async () => {
				const result = await command.execute({
					description: validDescription,
					options: { json: true }
				})

				expect(typeof result).toBe('object')
				if (typeof result === 'object') {
					expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
				}
			})
		})

		describe('--body flag behavior', () => {
			const preFormattedBody = '## Requirements\n- Item 1\n- Item 2\n\n## Acceptance Criteria\n- Test passes'

			beforeEach(() => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(true)
				vi.mocked(mockEnhancementService.createEnhancedIssue).mockResolvedValue({
					number: 123,
					url: 'https://github.com/owner/repo/issues/123',
				})
				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockResolvedValue(undefined)
			})

			it('should still enhance when body is provided', async () => {
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced description')

				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(mockEnhancementService.enhanceDescription).toHaveBeenCalledWith(
					`${validDescription}\n\n${preFormattedBody}`
				)
			})

			it('should use enhanced result as issue body when body is provided', async () => {
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced body')

				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(mockEnhancementService.createEnhancedIssue).toHaveBeenCalledWith(
					validDescription,
					'Enhanced body',
					undefined
				)
			})

			it('should validate description with hasBody=true when body is provided', async () => {
				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(mockEnhancementService.validateDescription).toHaveBeenCalledWith(validDescription, true)
			})

			it('should pass combined title and body to enhancer', async () => {
				vi.mocked(mockEnhancementService.enhanceDescription).mockResolvedValue('Enhanced body')

				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(mockEnhancementService.enhanceDescription).toHaveBeenCalledWith(
					`${validDescription}\n\n${preFormattedBody}`
				)
			})

			it('should still call waitForReviewAndOpen when body is provided', async () => {
				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(mockEnhancementService.waitForReviewAndOpen).toHaveBeenCalledWith(123)
			})

			it('should execute workflow with enhance step when body is provided', async () => {
				const calls: string[] = []

				vi.mocked(mockEnhancementService.validateDescription).mockImplementation(() => {
					calls.push('validate')
					return true
				})

				vi.mocked(mockEnhancementService.enhanceDescription).mockImplementation(async () => {
					calls.push('enhance')
					return 'Enhanced description'
				})

				vi.mocked(mockEnhancementService.createEnhancedIssue).mockImplementation(async () => {
					calls.push('create')
					return { number: 123, url: 'https://github.com/owner/repo/issues/123' }
				})

				vi.mocked(mockEnhancementService.waitForReviewAndOpen).mockImplementation(async () => {
					calls.push('review')
				})

				await command.execute({
					description: validDescription,
					options: { body: preFormattedBody }
				})

				expect(calls).toEqual(['validate', 'enhance', 'create', 'review'])
			})

			it('should accept short descriptions when body is provided', async () => {
				// Short description that would fail standard validation
				const shortDescription = 'Fix bug'

				await command.execute({
					description: shortDescription,
					options: { body: preFormattedBody }
				})

				// Should call validateDescription with hasBody=true
				expect(mockEnhancementService.validateDescription).toHaveBeenCalledWith(
					expect.stringMatching(/^Fix bug$/i),
					true
				)
			})

			it('should throw error for empty description even with body provided', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(false)

				await expect(
					command.execute({
						description: '',
						options: { body: preFormattedBody }
					})
				).rejects.toThrow('Description is required and cannot be empty')
			})

			it('should throw different error message when validation fails with body', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(false)

				await expect(
					command.execute({
						description: '',
						options: { body: preFormattedBody }
					})
				).rejects.toThrow('Description is required and cannot be empty')
			})

			it('should throw standard error message when validation fails without body', async () => {
				vi.mocked(mockEnhancementService.validateDescription).mockReturnValue(false)

				await expect(
					command.execute({
						description: 'short',
						options: {}
					})
				).rejects.toThrow('Description is required and must be more than 30 characters with at least 3 words')
			})
		})
	})
})
