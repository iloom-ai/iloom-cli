import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionSummaryService } from '../../src/lib/SessionSummaryService.js'
import type { PromptTemplateManager } from '../../src/lib/PromptTemplateManager.js'
import type { MetadataManager } from '../../src/lib/MetadataManager.js'
import type { SettingsManager } from '../../src/lib/SettingsManager.js'

// Mock all external dependencies
vi.mock('../../src/utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	},
}))

vi.mock('../../src/utils/claude.js', () => ({
	launchClaude: vi.fn(),
	generateDeterministicSessionId: vi.fn(),
}))

vi.mock('../../src/utils/claude-transcript.js', () => ({
	readSessionContext: vi.fn(),
}))

vi.mock('../../src/utils/remote.js', () => ({
	hasMultipleRemotes: vi.fn(),
}))

vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
		readFile: vi.fn(),
	},
}))

// Mock IssueManagementProviderFactory
vi.mock('../../src/mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn(),
	},
}))

// Mock VCSProviderFactory
vi.mock('../../src/lib/VCSProviderFactory.js', () => ({
	VCSProviderFactory: {
		create: vi.fn(),
	},
}))

describe('SessionSummaryService - VCS provider routing for PR comments', () => {
	let service: SessionSummaryService
	let mockTemplateManager: Partial<PromptTemplateManager>
	let mockMetadataManager: Partial<MetadataManager>
	let mockSettingsManager: Partial<SettingsManager>
	let mockCreateComment: ReturnType<typeof vi.fn>

	const makeService = (issueProvider = 'github') => {
		mockSettingsManager = {
			loadSettings: vi.fn().mockResolvedValue({
				attribution: 'off',
				issueManagement: { provider: issueProvider },
			}),
			getSummaryModel: vi.fn().mockReturnValue('haiku'),
		}
		return new SessionSummaryService(
			mockTemplateManager as PromptTemplateManager,
			mockMetadataManager as MetadataManager,
			mockSettingsManager as SettingsManager
		)
	}

	beforeEach(async () => {
		const { hasMultipleRemotes } = await import('../../src/utils/remote.js')
		vi.mocked(hasMultipleRemotes).mockResolvedValue(false)

		const { VCSProviderFactory } = await import('../../src/lib/VCSProviderFactory.js')
		vi.mocked(VCSProviderFactory.create).mockReturnValue(null)

		mockCreateComment = vi.fn().mockResolvedValue({})
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')
		vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
			createComment: mockCreateComment,
		} as never)

		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('Mock prompt'),
		}

		mockMetadataManager = {
			readMetadata: vi.fn().mockResolvedValue(null),
		}

		service = makeService()
	})

	it('uses VCS provider (BitBucket) to post PR comment when prNumber is provided and BitBucket is configured', async () => {
		const { VCSProviderFactory } = await import('../../src/lib/VCSProviderFactory.js')
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')

		const mockCreatePRComment = vi.fn().mockResolvedValue(undefined)
		vi.mocked(VCSProviderFactory.create).mockReturnValue({
			providerName: 'bitbucket',
			supportsForks: false,
			supportsDraftPRs: false,
			createPRComment: mockCreatePRComment,
			checkForExistingPR: vi.fn(),
			createPR: vi.fn(),
			fetchPR: vi.fn(),
			getPRUrl: vi.fn(),
			detectRepository: vi.fn(),
			getTargetRemote: vi.fn(),
		})

		await service.postSummary(42, 'Test summary', '/test/path', 99)

		// Should use BitBucket VCS provider, not GitHub issue management
		expect(mockCreatePRComment).toHaveBeenCalledWith(99, expect.any(String), '/test/path')
		// GitHub issue management should NOT have been called for PR posting
		expect(IssueManagementProviderFactory.create).not.toHaveBeenCalled()
	})

	it('uses GitHub issue management provider to post PR comment when no VCS provider is configured', async () => {
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')

		// VCSProviderFactory.create already returns null from beforeEach

		await service.postSummary(42, 'Test summary', '/test/path', 99)

		// Should fall back to GitHub issue management with type 'pr'
		expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('github', expect.anything())
		expect(mockCreateComment).toHaveBeenCalledWith({
			number: '99',
			body: expect.any(String),
			type: 'pr',
		})
	})

	it('uses configured issue management provider (jira) for issue comments - not hardcoded github', async () => {
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')

		// Create service with jira settings
		service = makeService('jira')

		// Post to issue (no prNumber)
		await service.postSummary(42, 'Test summary', '/test/path')

		// Should use jira provider, not hardcoded github
		expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('jira', expect.anything())
		expect(mockCreateComment).toHaveBeenCalledWith({
			number: '42',
			body: expect.any(String),
			type: 'issue',
		})
	})

	it('uses GitHub issue management when posting to issue with default settings', async () => {
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')

		// Post to issue (no prNumber) with default settings (github)
		await service.postSummary(42, 'Test summary', '/test/path')

		expect(IssueManagementProviderFactory.create).toHaveBeenCalledWith('github', expect.anything())
		expect(mockCreateComment).toHaveBeenCalledWith({
			number: '42',
			body: expect.any(String),
			type: 'issue',
		})
	})
})
