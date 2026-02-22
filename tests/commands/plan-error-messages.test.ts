import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlanCommand } from '../../src/commands/plan.js'
import * as claudeUtils from '../../src/utils/claude.js'
import * as mcpUtils from '../../src/utils/mcp.js'
import * as firstRunSetup from '../../src/utils/first-run-setup.js'
import * as identifierParser from '../../src/utils/IdentifierParser.js'
import { IssueTrackerFactory } from '../../src/lib/IssueTrackerFactory.js'

// Mock all external dependencies
vi.mock('../../src/utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	},
	createStderrLogger: vi.fn().mockReturnValue({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	}),
}))

vi.mock('../../src/utils/logger-context.js', () => ({
	withLogger: vi.fn().mockImplementation((_logger: unknown, fn: () => unknown) => fn()),
	getLogger: vi.fn().mockReturnValue({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}))

vi.mock('../../src/utils/claude.js')
vi.mock('../../src/utils/mcp.js')
vi.mock('../../src/utils/first-run-setup.js')
vi.mock('../../src/utils/IdentifierParser.js')

vi.mock('../../src/lib/SettingsManager.js', () => ({
	SettingsManager: vi.fn(() => ({
		// Return a non-null settings object so IssueTrackerFactory.getProviderName is called with it
		loadSettings: vi.fn().mockResolvedValue({ issueManagement: { provider: 'github' } }),
		getPlanModel: vi.fn().mockReturnValue('opus'),
		getPlanPlanner: vi.fn().mockReturnValue('claude'),
		getPlanReviewer: vi.fn().mockReturnValue('none'),
	})),
	PlanCommandSettingsSchema: {
		shape: {
			planner: { safeParse: vi.fn().mockReturnValue({ success: true }) },
			reviewer: { safeParse: vi.fn().mockReturnValue({ success: true }) },
		},
	},
}))

vi.mock('../../src/lib/IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		getProviderName: vi.fn().mockReturnValue('github'),
		create: vi.fn().mockReturnValue({
			detectInputType: vi.fn(),
		}),
	},
}))

vi.mock('../../src/mcp/IssueManagementProviderFactory.js', () => ({
	IssueManagementProviderFactory: {
		create: vi.fn(),
	},
}))

vi.mock('../../src/utils/prompt.js', () => ({
	promptConfirmation: vi.fn(),
	isInteractiveEnvironment: vi.fn().mockReturnValue(false), // Non-interactive for direct error path
}))

vi.mock('../../src/lib/TelemetryService.js', () => ({
	TelemetryService: {
		getInstance: vi.fn().mockReturnValue({ track: vi.fn() }),
	},
}))

describe('PlanCommand - provider-specific error messages', () => {
	let command: PlanCommand

	beforeEach(() => {
		// Claude CLI is available so we proceed to MCP config check
		vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
		vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

		// MCP config generation fails - this triggers the provider-specific error messages
		vi.mocked(mcpUtils.generateIssueManagementMcpConfig).mockRejectedValue(
			new Error('No remote configured')
		)

		vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(false)
		vi.mocked(firstRunSetup.launchFirstRunSetup).mockResolvedValue(undefined)
		vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({ isIssueIdentifier: false })

		command = new PlanCommand()
	})

	it('throws Jira-specific error message when provider is jira (non-interactive)', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('jira')

		await expect(command.execute()).rejects.toThrow('JIRA_API_TOKEN')
	})

	it('Jira error message does not reference LINEAR_API_TOKEN', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('jira')

		let errorMessage = ''
		try {
			await command.execute()
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e)
		}
		expect(errorMessage).not.toContain('LINEAR_API_TOKEN')
		expect(errorMessage).toContain('JIRA_API_TOKEN')
	})

	it('throws Linear-specific error message when provider is linear (non-interactive)', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')

		await expect(command.execute()).rejects.toThrow('LINEAR_API_TOKEN')
	})

	it('Linear error message does not reference JIRA_API_TOKEN', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')

		let errorMessage = ''
		try {
			await command.execute()
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e)
		}
		expect(errorMessage).not.toContain('JIRA_API_TOKEN')
		expect(errorMessage).toContain('LINEAR_API_TOKEN')
	})

	it('throws GitHub-specific error message when provider is github (non-interactive)', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')

		await expect(command.execute()).rejects.toThrow('GitHub remote')
	})

	it('GitHub error message does not reference LINEAR_API_TOKEN or JIRA_API_TOKEN', async () => {
		vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')

		let errorMessage = ''
		try {
			await command.execute()
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : String(e)
		}
		expect(errorMessage).not.toContain('LINEAR_API_TOKEN')
		expect(errorMessage).not.toContain('JIRA_API_TOKEN')
	})
})
