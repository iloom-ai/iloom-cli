import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PRManager } from '../../src/lib/PRManager.js'

vi.mock('../../src/utils/github.js', () => ({
	executeGhCommand: vi.fn(),
}))

vi.mock('../../src/utils/claude.js', () => ({
	launchClaude: vi.fn(),
	detectClaudeCli: vi.fn().mockResolvedValue(false), // No Claude available, use template
}))

vi.mock('../../src/utils/remote.js', () => ({
	getEffectivePRTargetRemote: vi.fn().mockResolvedValue('origin'),
	getConfiguredRepoFromSettings: vi.fn(),
	parseGitRemotes: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../src/utils/browser.js', () => ({
	openBrowser: vi.fn(),
}))

vi.mock('../../src/utils/logger-context.js', () => ({
	getLogger: vi.fn().mockReturnValue({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

vi.mock('../../src/mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn().mockReturnValue({
			issuePrefix: '#',
		}),
	},
}))

describe('PRManager - provider-agnostic PR body prompt', () => {
	let prManager: PRManager

	beforeEach(async () => {
		const { IssueManagementProviderFactory } = await import('../../src/mcp/IssueManagementProviderFactory.js')
		vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
			issuePrefix: '#',
		} as never)

		// Create with full mock settings including issueManagement
		prManager = new PRManager({ issueManagement: { provider: 'github' } })
	})

	it('uses generic "pull request" language in the PR body prompt (not "GitHub pull request")', () => {
		// Access private method via type assertion to verify the prompt content
		const prompt = (prManager as unknown as { buildPRBodyPrompt: (n?: number) => string }).buildPRBodyPrompt(42)

		expect(prompt).not.toContain('GitHub pull request')
		expect(prompt).toContain('pull request')
	})

	it('does not mention "GitHub pull request body" in the output instruction', () => {
		const prompt = (prManager as unknown as { buildPRBodyPrompt: (n?: number) => string }).buildPRBodyPrompt()

		// The output instruction should be provider-agnostic
		expect(prompt).not.toMatch(/GitHub pull request body/i)
		// Should still tell the AI to produce a PR body
		expect(prompt).toMatch(/pull request body/i)
	})

	it('generates fallback template body without hardcoded GitHub reference', async () => {
		// When Claude is unavailable (mocked to return false), falls back to template
		const body = await prManager.generatePRBody(42, '/test/path')
		expect(body).not.toContain('GitHub')
		expect(body).toContain('42') // Issue number should be referenced
	})
})
