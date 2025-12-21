import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionSummaryService, type SessionSummaryInput } from './SessionSummaryService.js'
import type { PromptTemplateManager } from './PromptTemplateManager.js'
import type { MetadataManager, LoomMetadata } from './MetadataManager.js'
import type { SettingsManager, IloomSettings } from './SettingsManager.js'
import type { IssueManagementProvider } from '../mcp/types.js'

// Mock the claude utility
vi.mock('../utils/claude.js', () => ({
	launchClaude: vi.fn(),
}))

// Mock the claude-transcript utility
vi.mock('../utils/claude-transcript.js', () => ({
	readSessionContext: vi.fn(),
}))

// Mock the recap utility
vi.mock('../utils/recap.js', () => ({
	readRecapForPrompt: vi.fn(),
}))

// Mock the IssueManagementProviderFactory
vi.mock('../mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn(),
	},
}))

// Mock the remote utility for fork detection
vi.mock('../utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn(),
}))

// Import mocked modules
import { launchClaude } from '../utils/claude.js'
import { readSessionContext } from '../utils/claude-transcript.js'
import { readRecapForPrompt } from '../utils/recap.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { hasMultipleRemotes } from '../utils/remote.js'

describe('SessionSummaryService', () => {
	// Mock dependencies
	let mockTemplateManager: PromptTemplateManager
	let mockMetadataManager: MetadataManager
	let mockSettingsManager: SettingsManager
	let mockIssueProvider: IssueManagementProvider
	let service: SessionSummaryService

	const defaultInput: SessionSummaryInput = {
		worktreePath: '/path/to/worktree',
		issueNumber: 123,
		branchName: 'feat/issue-123__test-feature',
		loomType: 'issue',
	}

	const defaultMetadata: LoomMetadata = {
		description: 'Test loom',
		created_at: '2024-01-01T00:00:00Z',
		branchName: 'feat/issue-123__test-feature',
		worktreePath: '/path/to/worktree',
		issueType: 'issue',
		issue_numbers: ['123'],
		pr_numbers: [],
		issueTracker: 'github',
		colorHex: '#dcebff',
		sessionId: 'test-session-id-12345',
	}

	const defaultSettings: IloomSettings = {
		issueManagement: {
			provider: 'github',
		},
		workflows: {
			issue: {
				generateSummary: true,
			},
			pr: {
				generateSummary: true,
			},
		},
	}

	beforeEach(() => {
		// Create mock template manager
		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('Generated prompt content'),
			loadTemplate: vi.fn(),
			substituteVariables: vi.fn(),
		} as unknown as PromptTemplateManager

		// Create mock metadata manager
		mockMetadataManager = {
			readMetadata: vi.fn().mockResolvedValue(defaultMetadata),
			writeMetadata: vi.fn(),
			deleteMetadata: vi.fn(),
			slugifyPath: vi.fn(),
			listAllMetadata: vi.fn(),
		} as unknown as MetadataManager

		// Create mock settings manager
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue(defaultSettings),
			getProtectedBranches: vi.fn(),
			getSpinModel: vi.fn(),
			getSummaryModel: vi.fn().mockReturnValue('sonnet'),
		} as unknown as SettingsManager

		// Create mock issue provider
		mockIssueProvider = {
			providerName: 'github',
			getIssue: vi.fn(),
			getComment: vi.fn(),
			createComment: vi.fn().mockResolvedValue({ id: 'comment-123', url: 'https://github.com/...' }),
			updateComment: vi.fn(),
		}

		// Setup factory mock
		vi.mocked(IssueManagementProviderFactory.create).mockReturnValue(mockIssueProvider)

		// Setup Claude mock - must be > 100 chars to pass length check
		vi.mocked(launchClaude).mockResolvedValue('## iloom Session Summary\n\n**Key Themes:**\n- Theme one about testing\n- Theme two about implementation\n\n### Key Insights\n- Test insight one\n- Test insight two')

		// Setup transcript mock - returns null by default (no compact summaries)
		vi.mocked(readSessionContext).mockResolvedValue(null)

		// Setup recap mock - returns empty by default (no recap context)
		vi.mocked(readRecapForPrompt).mockResolvedValue('')

		// Setup remote mock - defaults to single remote (no fork mode)
		vi.mocked(hasMultipleRemotes).mockResolvedValue(false)

		// Create service with mocks
		service = new SessionSummaryService(
			mockTemplateManager,
			mockMetadataManager,
			mockSettingsManager
		)
	})

	describe('generateAndPostSummary', () => {
		it('should generate summary via headless Claude and post to issue', async () => {
			await service.generateAndPostSummary(defaultInput)

			// Verify metadata was read
			expect(mockMetadataManager.readMetadata).toHaveBeenCalledWith(defaultInput.worktreePath)

			// Verify settings were loaded
			expect(mockSettingsManager.loadSettings).toHaveBeenCalledWith(defaultInput.worktreePath)

			// Verify template was loaded with correct variables (COMPACT_SUMMARIES is empty when no transcript)
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('session-summary', {
				ISSUE_NUMBER: '123',
				BRANCH_NAME: 'feat/issue-123__test-feature',
				LOOM_TYPE: 'issue',
				COMPACT_SUMMARIES: '',
				RECAP_JSON: '',
			})

			// Verify Claude was called
			expect(launchClaude).toHaveBeenCalledWith('Generated prompt content', {
				headless: true,
				model: 'sonnet',
				sessionId: 'test-session-id-12345',
			})

			// Verify provider was created and comment was posted
			expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('github')
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: '## iloom Session Summary\n\n**Key Themes:**\n- Theme one about testing\n- Theme two about implementation\n\n### Key Insights\n- Test insight one\n- Test insight two',
				type: 'issue',
			})
		})

		it('should skip and log when sessionId is null (legacy loom)', async () => {
			vi.mocked(mockMetadataManager.readMetadata).mockResolvedValue({
				...defaultMetadata,
				sessionId: null,
			})

			await service.generateAndPostSummary(defaultInput)

			// Should not proceed to template loading or Claude invocation
			expect(mockTemplateManager.getPrompt).not.toHaveBeenCalled()
			expect(launchClaude).not.toHaveBeenCalled()
			expect(mockIssueProvider.createComment).not.toHaveBeenCalled()
		})

		it('should skip when loom type is "branch"', async () => {
			const branchInput: SessionSummaryInput = {
				...defaultInput,
				loomType: 'branch',
			}

			await service.generateAndPostSummary(branchInput)

			// Should not even read metadata for branch type
			expect(mockMetadataManager.readMetadata).not.toHaveBeenCalled()
			expect(launchClaude).not.toHaveBeenCalled()
		})

		it('should skip when generateSummary setting is false', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				workflows: {
					issue: {
						generateSummary: false,
					},
				},
			})

			await service.generateAndPostSummary(defaultInput)

			// Should load settings but not proceed to template/Claude
			expect(mockSettingsManager.loadSettings).toHaveBeenCalled()
			expect(mockTemplateManager.getPrompt).not.toHaveBeenCalled()
			expect(launchClaude).not.toHaveBeenCalled()
		})

		it('should continue workflow on Claude invocation failure (non-blocking)', async () => {
			vi.mocked(launchClaude).mockRejectedValue(new Error('Claude API error'))

			// Should not throw
			await expect(service.generateAndPostSummary(defaultInput)).resolves.not.toThrow()

			// Should have attempted to call Claude
			expect(launchClaude).toHaveBeenCalled()
			// But should not have posted comment
			expect(mockIssueProvider.createComment).not.toHaveBeenCalled()
		})

		it('should continue workflow on comment posting failure (non-blocking)', async () => {
			vi.mocked(mockIssueProvider.createComment).mockRejectedValue(new Error('GitHub API error'))

			// Should not throw
			await expect(service.generateAndPostSummary(defaultInput)).resolves.not.toThrow()

			// Should have called Claude and attempted to post
			expect(launchClaude).toHaveBeenCalled()
			expect(mockIssueProvider.createComment).toHaveBeenCalled()
		})

		it('should use correct issue management provider based on settings', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				issueManagement: {
					provider: 'linear',
				},
			})

			await service.generateAndPostSummary(defaultInput)

			expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('linear')
		})

		it('should skip when Claude returns empty result', async () => {
			vi.mocked(launchClaude).mockResolvedValue('')

			await service.generateAndPostSummary(defaultInput)

			// Should not post empty comment
			expect(mockIssueProvider.createComment).not.toHaveBeenCalled()
		})

		it('should skip when Claude returns summary too short (<100 chars)', async () => {
			vi.mocked(launchClaude).mockResolvedValue('Short summary')

			await service.generateAndPostSummary(defaultInput)

			// Should not post short summary
			expect(mockIssueProvider.createComment).not.toHaveBeenCalled()
		})

		it('should work with PR loom type', async () => {
			const prInput: SessionSummaryInput = {
				...defaultInput,
				loomType: 'pr',
			}

			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				workflows: {
					pr: {
						generateSummary: true,
					},
				},
			})

			await service.generateAndPostSummary(prInput)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('session-summary', expect.objectContaining({
				LOOM_TYPE: 'pr',
				COMPACT_SUMMARIES: '',
			}))
			expect(mockIssueProvider.createComment).toHaveBeenCalled()
		})

		it('should include compact summaries in prompt when transcript exists', async () => {
			const compactSummary = 'Summary of previous conversation: implemented feature X'
			vi.mocked(readSessionContext).mockResolvedValue(compactSummary)

			await service.generateAndPostSummary(defaultInput)

			// Verify transcript was read with correct session ID
			expect(readSessionContext).toHaveBeenCalledWith(
				defaultInput.worktreePath,
				'test-session-id-12345'
			)

			// Verify compact summaries were included in template variables
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('session-summary', {
				ISSUE_NUMBER: '123',
				BRANCH_NAME: 'feat/issue-123__test-feature',
				LOOM_TYPE: 'issue',
				COMPACT_SUMMARIES: compactSummary,
				RECAP_JSON: '',
			})
		})

		it('should include recap context in prompt when recap exists', async () => {
			const recapJson = JSON.stringify(
				{
					goal: 'Test goal',
					entries: [
						{ id: 'uuid-1', timestamp: '2025-01-01T00:00:00Z', type: 'decision', content: 'Use TypeScript' },
					],
				},
				null,
				2
			)
			vi.mocked(readRecapForPrompt).mockResolvedValue(recapJson)

			await service.generateAndPostSummary(defaultInput)

			expect(readRecapForPrompt).toHaveBeenCalledWith(defaultInput.worktreePath)
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith('session-summary', expect.objectContaining({
				RECAP_JSON: recapJson,
			}))
		})

		it('should work without compact summaries (short sessions)', async () => {
			vi.mocked(readSessionContext).mockResolvedValue(null)

			await service.generateAndPostSummary(defaultInput)

			// Should still call Claude and post comment
			expect(launchClaude).toHaveBeenCalled()
			expect(mockIssueProvider.createComment).toHaveBeenCalled()
		})

		it('should handle transcript read errors gracefully', async () => {
			vi.mocked(readSessionContext).mockRejectedValue(new Error('Permission denied'))

			// Should not throw - non-blocking
			await expect(service.generateAndPostSummary(defaultInput)).resolves.not.toThrow()
		})

		it('should post to PR when prNumber is provided', async () => {
			const inputWithPrNumber: SessionSummaryInput = {
				...defaultInput,
				prNumber: 456,
			}

			await service.generateAndPostSummary(inputWithPrNumber)

			// Verify comment was posted to PR with type: 'pr'
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '456',
				body: expect.any(String),
				type: 'pr',
			})
		})

		it('should post to issue when prNumber is not provided', async () => {
			await service.generateAndPostSummary(defaultInput)

			// Verify comment was posted to issue with type: 'issue'
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.any(String),
				type: 'issue',
			})
		})
	})

	describe('shouldGenerateSummary', () => {
		it('should return true for issue type when generateSummary not configured (default)', () => {
			const settings: IloomSettings = {
				workflows: {},
			}

			expect(service.shouldGenerateSummary('issue', settings)).toBe(true)
		})

		it('should return true for pr type when generateSummary not configured (default)', () => {
			const settings: IloomSettings = {
				workflows: {},
			}

			expect(service.shouldGenerateSummary('pr', settings)).toBe(true)
		})

		it('should return false for branch type regardless of configuration', () => {
			const settings: IloomSettings = {
				workflows: {
					regular: {
						generateSummary: true,
					},
				},
			}

			expect(service.shouldGenerateSummary('branch', settings)).toBe(false)
		})

		it('should respect explicit generateSummary: false setting for issue', () => {
			const settings: IloomSettings = {
				workflows: {
					issue: {
						generateSummary: false,
					},
				},
			}

			expect(service.shouldGenerateSummary('issue', settings)).toBe(false)
		})

		it('should respect explicit generateSummary: false setting for pr', () => {
			const settings: IloomSettings = {
				workflows: {
					pr: {
						generateSummary: false,
					},
				},
			}

			expect(service.shouldGenerateSummary('pr', settings)).toBe(false)
		})

		it('should respect explicit generateSummary: true setting', () => {
			const settings: IloomSettings = {
				workflows: {
					issue: {
						generateSummary: true,
					},
				},
			}

			expect(service.shouldGenerateSummary('issue', settings)).toBe(true)
		})
	})

	describe('attribution setting', () => {
		it('should append attribution when setting is "on" (always)', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				attribution: 'on',
			})
			vi.mocked(hasMultipleRemotes).mockResolvedValue(false) // Single remote

			await service.generateAndPostSummary(defaultInput)

			// Should not check remotes when attribution is always on
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.stringContaining('\n\n---\n*Generated with 🤖❤️ by [iloom.ai](https://iloom.ai)*'),
				type: 'issue',
			})
		})

		it('should not append attribution when setting is "off" (never)', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				attribution: 'off',
			})
			vi.mocked(hasMultipleRemotes).mockResolvedValue(true) // Fork mode

			await service.generateAndPostSummary(defaultInput)

			// Should not show attribution even in fork mode
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.not.stringContaining('iloom.ai'),
				type: 'issue',
			})
		})

		it('should append attribution when setting is "upstreamOnly" and in fork mode', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				attribution: 'upstreamOnly',
			})
			vi.mocked(hasMultipleRemotes).mockResolvedValue(true)

			await service.generateAndPostSummary(defaultInput)

			expect(hasMultipleRemotes).toHaveBeenCalledWith(defaultInput.worktreePath)
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.stringContaining('\n\n---\n*Generated with 🤖❤️ by [iloom.ai](https://iloom.ai)*'),
				type: 'issue',
			})
		})

		it('should not append attribution when setting is "upstreamOnly" and single remote', async () => {
			vi.mocked(mockSettingsManager.loadSettings).mockResolvedValue({
				...defaultSettings,
				attribution: 'upstreamOnly',
			})
			vi.mocked(hasMultipleRemotes).mockResolvedValue(false)

			await service.generateAndPostSummary(defaultInput)

			expect(hasMultipleRemotes).toHaveBeenCalledWith(defaultInput.worktreePath)
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.not.stringContaining('iloom.ai'),
				type: 'issue',
			})
		})

		it('should default to "upstreamOnly" when attribution setting is undefined', async () => {
			// defaultSettings has no attribution field
			vi.mocked(hasMultipleRemotes).mockResolvedValue(true)

			await service.generateAndPostSummary(defaultInput)

			// Should behave like upstreamOnly - check remotes and show attribution
			expect(hasMultipleRemotes).toHaveBeenCalledWith(defaultInput.worktreePath)
			expect(mockIssueProvider.createComment).toHaveBeenCalledWith({
				number: '123',
				body: expect.stringContaining('\n\n---\n*Generated with 🤖❤️ by [iloom.ai](https://iloom.ai)*'),
				type: 'issue',
			})
		})

		it('should handle hasMultipleRemotes errors gracefully', async () => {
			vi.mocked(hasMultipleRemotes).mockRejectedValue(new Error('Git error'))

			// Should not throw - non-blocking
			await expect(service.generateAndPostSummary(defaultInput)).resolves.not.toThrow()
		})
	})
})
