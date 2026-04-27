/* global AbortSignal */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlanCommand } from './plan.js'
import type { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import type { AgentManager } from '../lib/AgentManager.js'
import * as claudeUtils from '../utils/claude.js'
import * as claudeTrust from '../utils/claude-trust.js'
import * as mcpUtils from '../utils/mcp.js'
import * as systemPromptWriter from '../utils/system-prompt-writer.js'
import * as firstRunSetup from '../utils/first-run-setup.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import * as identifierParser from '../utils/IdentifierParser.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { HarnessServer } from '../lib/HarnessServer.js'
import type { HarnessHandler } from '../lib/HarnessServer.js'
import { processMarkdownImages } from '../utils/image-processor.js'

// Mock dependencies
vi.mock('../utils/claude.js')
vi.mock('../utils/claude-trust.js')
vi.mock('../utils/mcp.js')
vi.mock('../utils/system-prompt-writer.js')
vi.mock('../utils/first-run-setup.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('../mcp/IssueManagementProviderFactory.js')
vi.mock('../lib/HarnessServer.js')
vi.mock('../utils/image-processor.js', () => ({
	processMarkdownImages: vi.fn(),
}))
vi.mock('./start.js', () => {
	class MockStartCommand {
		async execute() {
			return { id: 'test-loom', path: '/tmp/test-epic-worktree', branch: 'issue/42', type: 'epic' as const, identifier: '42' }
		}
	}
	return { StartCommand: MockStartCommand }
})

vi.mock('./ignite.js', () => {
	class MockIgniteCommand {
		async execute() {
			return undefined
		}
	}
	return { IgniteCommand: MockIgniteCommand, WorktreeValidationError: class WorktreeValidationError extends Error {} }
})
vi.mock('../lib/TelemetryService.js', () => ({
	TelemetryService: {
		getInstance: vi.fn(),
		resetInstance: vi.fn(),
	},
}))
vi.mock('../lib/SettingsManager.js', () => ({
	SettingsManager: vi.fn(() => ({
		loadSettings: vi.fn().mockResolvedValue(null),
		getPlanModel: vi.fn().mockReturnValue('opus'),
		getPlanPlanner: vi.fn().mockReturnValue('claude'),
		getPlanReviewer: vi.fn().mockReturnValue('none'),
		getPlanWaveVerification: vi.fn().mockReturnValue(true),
		getPlanEffort: vi.fn().mockReturnValue('high'),
	})),
}))
vi.mock('../lib/IssueTrackerFactory.js', () => ({
	IssueTrackerFactory: {
		getProviderName: vi.fn().mockReturnValue('github'),
		create: vi.fn(),
	},
}))
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
	},
}))

describe('PlanCommand', () => {
	let command: PlanCommand
	let mockTemplateManager: PromptTemplateManager
	let mockAgentManager: {
		loadAndPrepare: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		// Create mock template manager
		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('mocked plan prompt content'),
		} as unknown as PromptTemplateManager

		// Create mock agent manager
		mockAgentManager = {
			loadAndPrepare: vi.fn().mockResolvedValue({
				'iloom-issue-analyzer': {
					description: 'Issue analyzer agent',
					prompt: 'Analyze issues',
					model: 'opus',
				},
			}),
		}

		// Create command with mocked dependencies
		command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

		// Setup default mocks
		vi.mocked(claudeTrust.preAcceptClaudeTrust).mockResolvedValue(undefined)
		vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
		vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
		vi.mocked(mcpUtils.generateIssueManagementMcpConfig).mockResolvedValue([
			{ mcpServers: { issue_management: {} } },
		])
		vi.mocked(systemPromptWriter.prepareSystemPromptForPlatform).mockResolvedValue({
			appendSystemPromptFile: '/tmp/iloom-system-prompt-test.md',
		})
		// Default: project is already configured (no first-run setup needed)
		vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(false)
		vi.mocked(firstRunSetup.launchFirstRunSetup).mockResolvedValue(undefined)
		// Default: input is not an issue identifier (non-decomposition mode)
		vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({ isIssueIdentifier: false })
		// Default: TelemetryService mock
		const mockTrack = vi.fn()
		vi.mocked(TelemetryService.getInstance).mockReturnValue({ track: mockTrack } as unknown as TelemetryService)
		// Default: processMarkdownImages returns the input unchanged
		vi.mocked(processMarkdownImages).mockImplementation(async (content: string) => content)
	})

	describe('VS Code mode detection', () => {
		it('should pass IS_VSCODE_MODE: true when ILOOM_VSCODE=1', async () => {
			// Set ILOOM_VSCODE environment variable
			const originalEnv = process.env.ILOOM_VSCODE
			process.env.ILOOM_VSCODE = '1'

			try {
				await command.execute()

				// Verify template manager was called with IS_VSCODE_MODE: true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						IS_VSCODE_MODE: true,
					})
				)
			} finally {
				// Restore original environment
				if (originalEnv === undefined) {
					delete process.env.ILOOM_VSCODE
				} else {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})

		it('should pass IS_VSCODE_MODE: false when ILOOM_VSCODE is not set', async () => {
			// Ensure ILOOM_VSCODE is not set
			const originalEnv = process.env.ILOOM_VSCODE
			delete process.env.ILOOM_VSCODE

			try {
				await command.execute()

				// Verify template manager was called with IS_VSCODE_MODE: false
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						IS_VSCODE_MODE: false,
					})
				)
			} finally {
				// Restore original environment
				if (originalEnv !== undefined) {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})

		it('should pass IS_VSCODE_MODE: false when ILOOM_VSCODE is empty string', async () => {
			// Set ILOOM_VSCODE to empty string
			const originalEnv = process.env.ILOOM_VSCODE
			process.env.ILOOM_VSCODE = ''

			try {
				await command.execute()

				// Verify template manager was called with IS_VSCODE_MODE: false
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						IS_VSCODE_MODE: false,
					})
				)
			} finally {
				// Restore original environment
				if (originalEnv === undefined) {
					delete process.env.ILOOM_VSCODE
				} else {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})

		it('should pass IS_VSCODE_MODE: false when ILOOM_VSCODE is 0', async () => {
			// Set ILOOM_VSCODE to '0'
			const originalEnv = process.env.ILOOM_VSCODE
			process.env.ILOOM_VSCODE = '0'

			try {
				await command.execute()

				// Verify template manager was called with IS_VSCODE_MODE: false
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						IS_VSCODE_MODE: false,
					})
				)
			} finally {
				// Restore original environment
				if (originalEnv === undefined) {
					delete process.env.ILOOM_VSCODE
				} else {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})
	})

	describe('Issue tracker and VCS provider variables', () => {
		it('should pass github tracker variables by default', async () => {
			await command.execute()

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({
					ISSUE_TRACKER: 'github',
					IS_GITHUB_TRACKER: true,
					VCS_PROVIDER: 'github',
					IS_GITHUB_VCS: true,
				})
			)
		})

		it('should pass linear tracker with github VCS when configured', async () => {
			const { SettingsManager } = await import('../lib/SettingsManager.js')
			vi.mocked(SettingsManager).mockImplementation(() => ({
				loadSettings: vi.fn().mockResolvedValue({ issueManagement: { provider: 'linear' } }),
				getPlanModel: vi.fn().mockReturnValue('opus'),
				getPlanPlanner: vi.fn().mockReturnValue('claude'),
				getPlanReviewer: vi.fn().mockReturnValue('none'),
				getPlanWaveVerification: vi.fn().mockReturnValue(true),
				getPlanEffort: vi.fn().mockReturnValue('high'),
			}) as unknown as InstanceType<typeof SettingsManager>)
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
			command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

			await command.execute()

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({
					ISSUE_TRACKER: 'linear',
					IS_GITHUB_TRACKER: false,
					VCS_PROVIDER: 'github',
					IS_GITHUB_VCS: true,
				})
			)
		})

		it('should pass jira tracker when configured', async () => {
			const { SettingsManager } = await import('../lib/SettingsManager.js')
			vi.mocked(SettingsManager).mockImplementation(() => ({
				loadSettings: vi.fn().mockResolvedValue({ issueManagement: { provider: 'jira' } }),
				getPlanModel: vi.fn().mockReturnValue('opus'),
				getPlanPlanner: vi.fn().mockReturnValue('claude'),
				getPlanReviewer: vi.fn().mockReturnValue('none'),
				getPlanWaveVerification: vi.fn().mockReturnValue(true),
				getPlanEffort: vi.fn().mockReturnValue('high'),
			}) as unknown as InstanceType<typeof SettingsManager>)
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('jira')
			command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

			await command.execute()

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({
					ISSUE_TRACKER: 'jira',
					IS_GITHUB_TRACKER: false,
				})
			)
		})

		it('should pass bitbucket VCS when configured', async () => {
			const { SettingsManager } = await import('../lib/SettingsManager.js')
			vi.mocked(SettingsManager).mockImplementation(() => ({
				loadSettings: vi.fn().mockResolvedValue({
					versionControl: { provider: 'bitbucket' },
				}),
				getPlanModel: vi.fn().mockReturnValue('opus'),
				getPlanPlanner: vi.fn().mockReturnValue('claude'),
				getPlanReviewer: vi.fn().mockReturnValue('none'),
				getPlanWaveVerification: vi.fn().mockReturnValue(true),
				getPlanEffort: vi.fn().mockReturnValue('high'),
			}) as unknown as InstanceType<typeof SettingsManager>)
			command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

			await command.execute()

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({
					VCS_PROVIDER: 'bitbucket',
					IS_GITHUB_VCS: false,
				})
			)
		})
	})

	describe('Claude CLI availability', () => {
		it('should throw error when Claude CLI is not available', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(false)

			await expect(command.execute()).rejects.toThrow(
				'Claude Code CLI is required for planning sessions'
			)
		})

		it('should proceed when Claude CLI is available', async () => {
			vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)

			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalled()
		})
	})

	describe('MCP config generation', () => {
		it('should throw error when MCP config generation fails', async () => {
			vi.mocked(mcpUtils.generateIssueManagementMcpConfig).mockRejectedValue(
				new Error('No git remote configured')
			)

			await expect(command.execute()).rejects.toThrow(
				'Cannot start planning session: No git remote configured'
			)
		})
	})

	describe('Claude launch options', () => {
		it('should write the architect prompt to a file and pass appendSystemPromptFile', async () => {
			const mockPromptContent = 'Test architect prompt content'
			const mockPromptFile = '/tmp/iloom-system-prompt-test.md'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)
			vi.mocked(systemPromptWriter.prepareSystemPromptForPlatform).mockResolvedValue({
				appendSystemPromptFile: mockPromptFile,
			})

			await command.execute()

			expect(systemPromptWriter.prepareSystemPromptForPlatform).toHaveBeenCalledWith(
				mockPromptContent,
				expect.any(String),
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					appendSystemPromptFile: mockPromptFile,
				})
			)
		})

		it('should pass optional prompt as initial message', async () => {
			const testPrompt = 'Help me plan a new feature'

			await command.execute(testPrompt)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				testPrompt,
				expect.any(Object)
			)
		})

		it('should use default message when no prompt provided', async () => {
			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				'Help me plan a feature or decompose work into issues.',
				expect.any(Object)
			)
		})

		it('should pre-accept Claude trust for cwd before launching Claude', async () => {
			await command.execute()

			expect(claudeTrust.preAcceptClaudeTrust).toHaveBeenCalledWith(process.cwd())
		})

		it('should pre-approve issue management tools', async () => {
			await command.execute()

			const call = vi.mocked(claudeUtils.launchClaude).mock.calls[0]
			const options = call[1] as Record<string, unknown>
			expect(options.allowedTools).toEqual([
				'mcp__issue_management__get_issue',
				'mcp__issue_management__get_child_issues',
				'mcp__issue_management__create_issue',
				'mcp__issue_management__create_child_issue',
				'mcp__issue_management__create_comment',
				'mcp__issue_management__create_dependency',
				'mcp__issue_management__get_dependencies',
				'mcp__issue_management__remove_dependency',
			])
		})

		it('should load analyzer agent and pass to launchClaude', async () => {
			await command.execute()

			expect(mockAgentManager.loadAndPrepare).toHaveBeenCalledWith(
				undefined,
				expect.objectContaining({ PLANNER: 'claude' }),
				['iloom-issue-analyzer.md']
			)

			const call = vi.mocked(claudeUtils.launchClaude).mock.calls[0]
			const options = call[1] as Record<string, unknown>
			expect(options.agents).toEqual({
				'iloom-issue-analyzer': expect.objectContaining({
					description: 'Issue analyzer agent',
					model: 'opus',
				}),
			})
		})

		it('should continue without agents if loading fails', async () => {
			mockAgentManager.loadAndPrepare.mockRejectedValue(new Error('Agent loading failed'))

			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalled()
			const call = vi.mocked(claudeUtils.launchClaude).mock.calls[0]
			const options = call[1] as Record<string, unknown>
			expect(options.agents).toBeUndefined()
		})
	})

	describe('effort support', () => {
		it('passes effort in ClaudeCliOptions when effort is provided', async () => {
			await command.execute(undefined, undefined, undefined, undefined, undefined, undefined, 'high')

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ effort: 'high' })
			)
		})

		it('reads effort from settings.plan.effort when CLI not provided', async () => {
			const { SettingsManager } = await import('../lib/SettingsManager.js')
			vi.mocked(SettingsManager).mockImplementation(() => ({
				loadSettings: vi.fn().mockResolvedValue({ plan: { effort: 'low' } }),
				getPlanModel: vi.fn().mockReturnValue('opus'),
				getPlanPlanner: vi.fn().mockReturnValue('claude'),
				getPlanReviewer: vi.fn().mockReturnValue('none'),
				getPlanWaveVerification: vi.fn().mockReturnValue(true),
				getPlanEffort: vi.fn().mockReturnValue('low'),
			}) as unknown as InstanceType<typeof SettingsManager>)
			command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ effort: 'low' })
			)
		})

		it('passes "high" default effort when no effort configured', async () => {
			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ effort: 'high' })
			)
		})
	})

	describe('first-run setup check', () => {
		it('should launch first-run setup when project is not configured', async () => {
			vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(true)

			await command.execute()

			expect(firstRunSetup.launchFirstRunSetup).toHaveBeenCalled()
		})

		it('should skip first-run setup when project is already configured', async () => {
			vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(false)

			await command.execute()

			expect(firstRunSetup.launchFirstRunSetup).not.toHaveBeenCalled()
		})

		it('should launch first-run setup when FORCE_FIRST_TIME_SETUP is true', async () => {
			const originalEnv = process.env.FORCE_FIRST_TIME_SETUP
			process.env.FORCE_FIRST_TIME_SETUP = 'true'
			vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(false)

			try {
				await command.execute()

				expect(firstRunSetup.launchFirstRunSetup).toHaveBeenCalled()
			} finally {
				if (originalEnv === undefined) {
					delete process.env.FORCE_FIRST_TIME_SETUP
				} else {
					process.env.FORCE_FIRST_TIME_SETUP = originalEnv
				}
			}
		})

		it('should continue with planning after first-run setup completes', async () => {
			vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(true)

			await command.execute()

			// Verify that both setup and Claude launch happened
			expect(firstRunSetup.launchFirstRunSetup).toHaveBeenCalled()
			expect(claudeUtils.launchClaude).toHaveBeenCalled()
		})
	})

	describe('Print mode (--print flag)', () => {
		it('should call launchClaude with headless=true when print option is enabled', async () => {
			await command.execute('test prompt', undefined, undefined, undefined, undefined, { print: true })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headless: true,
				})
			)
		})

		it('should force bypassPermissions when print mode is enabled', async () => {
			await command.execute('test prompt', undefined, undefined, undefined, undefined, { print: true })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headless: true,
					permissionMode: 'bypassPermissions',
				})
			)
		})

		it('should forward outputFormat to launchClaude when provided', async () => {
			await command.execute('test prompt', undefined, undefined, undefined, undefined, { print: true, outputFormat: 'json' })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headless: true,
					outputFormat: 'json',
				})
			)
		})

		it('should forward verbose to launchClaude when provided', async () => {
			await command.execute('test prompt', undefined, undefined, undefined, undefined, { print: true, verbose: false })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headless: true,
					verbose: false,
				})
			)
		})

		it('should not set outputFormat or verbose when print mode is disabled', async () => {
			await command.execute('test prompt')

			const launchClaudeCall = vi.mocked(claudeUtils.launchClaude).mock.calls[0]
			expect(launchClaudeCall[1].headless).toBe(false)
			expect(launchClaudeCall[1].outputFormat).toBeUndefined()
			expect(launchClaudeCall[1].verbose).toBeUndefined()
		})

		it('should force autonomous mode when print mode is enabled (AUTONOMOUS MODE prompt)', async () => {
			await command.execute('test prompt', undefined, undefined, undefined, undefined, { print: true })

			// Print mode should automatically apply AUTONOMOUS MODE wrapper
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[AUTONOMOUS MODE]'),
				expect.any(Object)
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[TOPIC]'),
				expect.any(Object)
			)
		})

		it('should not require prompt when print mode enables autonomous', async () => {
			// Print mode with no prompt should work (unlike explicit --autonomous which requires prompt)
			await command.execute(undefined, undefined, undefined, undefined, undefined, { print: true })

			// Should still apply AUTONOMOUS MODE and use default message
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[AUTONOMOUS MODE]'),
				expect.any(Object)
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('Help me plan a feature or decompose work into issues'),
				expect.any(Object)
			)
		})

		it('should force autonomous even when no one-shot flags are passed with print mode', async () => {
			// Print mode should force autonomous behavior regardless of other flags
			await command.execute('test prompt', undefined, {}, undefined, undefined, { print: true })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[AUTONOMOUS MODE]'),
				expect.any(Object)
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					permissionMode: 'bypassPermissions',
				})
			)
		})
	})

	describe('flag decoupling', () => {
		describe('--one-shot=noReview', () => {
			it('should set AUTONOMOUS_MODE but NOT permissionMode=bypassPermissions', async () => {
				await command.execute('test prompt', undefined, { oneShot: 'noReview' })

				// Should set AUTONOMOUS_MODE in template variables
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: true,
					})
				)

				// Should wrap in [AUTONOMOUS MODE]
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)

				// Should NOT set permissionMode=bypassPermissions
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.not.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})

			it('should require a prompt', async () => {
				await expect(command.execute(undefined, undefined, { oneShot: 'noReview' })).rejects.toThrow(
					'Autonomous mode (--one-shot=noReview, --one-shot=bypassPermissions, --autonomous, or --yolo) requires a prompt or issue identifier'
				)
			})
		})

		describe('--one-shot=bypassPermissions', () => {
			it('should set both AUTONOMOUS_MODE and permissionMode=bypassPermissions', async () => {
				await command.execute('test prompt', undefined, { oneShot: 'bypassPermissions' })

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: true,
					})
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})

			it('should require a prompt', async () => {
				await expect(command.execute(undefined, undefined, { oneShot: 'bypassPermissions' })).rejects.toThrow(
					'Autonomous mode (--one-shot=noReview, --one-shot=bypassPermissions, --autonomous, or --yolo) requires a prompt or issue identifier'
				)
			})
		})

		describe('--dangerously-skip-permissions (standalone)', () => {
			it('should set permissionMode=bypassPermissions but NOT AUTONOMOUS_MODE', async () => {
				await command.execute('test prompt', undefined, { dangerouslySkipPermissions: true })

				// Should NOT set AUTONOMOUS_MODE
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: false,
					})
				)

				// Should NOT wrap in [AUTONOMOUS MODE]
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.not.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)

				// Should set permissionMode=bypassPermissions
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})

			it('should not require a prompt', async () => {
				// dangerouslySkipPermissions alone doesn't require a prompt
				await expect(command.execute(undefined, undefined, { dangerouslySkipPermissions: true })).resolves.toBeUndefined()
			})
		})

		describe('--autonomous (alias for --one-shot=bypassPermissions)', () => {
			it('should behave same as --one-shot=bypassPermissions (resolved at CLI level)', async () => {
				// --autonomous is resolved in cli.ts to { oneShot: 'bypassPermissions' }
				// Here we test PlanCommand with the resolved value
				await command.execute('test prompt', undefined, { oneShot: 'bypassPermissions' })

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: true,
					})
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})
		})

		describe('composability: --dangerously-skip-permissions + --one-shot=noReview', () => {
			it('should set both AUTONOMOUS_MODE and permissionMode=bypassPermissions', async () => {
				await command.execute('test prompt', undefined, { oneShot: 'noReview', dangerouslySkipPermissions: true })

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: true,
					})
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})
		})

		describe('--auto-swarm without one-shot mode', () => {
			let capturedHandlers: Map<string, HarnessHandler>
			let mockHarnessInstance: {
				path: string
				start: ReturnType<typeof vi.fn>
				stop: ReturnType<typeof vi.fn>
				registerHandler: ReturnType<typeof vi.fn>
			}

			beforeEach(() => {
				capturedHandlers = new Map<string, HarnessHandler>()
				mockHarnessInstance = {
					path: '/tmp/test-harness.sock',
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					registerHandler: vi.fn((type: string, handler: HarnessHandler) => {
						capturedHandlers.set(type, handler)
					}),
				}
				vi.mocked(HarnessServer).mockImplementation(
					() => mockHarnessInstance as unknown as HarnessServer
				)
				vi.mocked(mcpUtils.generateHarnessMcpConfig).mockReturnValue([
					{ mcpServers: { harness: {} } },
				])
				vi.mocked(claudeUtils.launchClaude).mockImplementation(async () => {
					const doneHandler = capturedHandlers.get('done')
					if (doneHandler) {
						await doneHandler({ epicIssueNumber: '42', childIssues: [1, 2, 3] })
					}
					return undefined
				})
			})

			it('should NOT set permissionMode=bypassPermissions', async () => {
				await command.execute('plan my epic', undefined, { autoSwarm: true })

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.not.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})

			it('should NOT wrap message in [AUTONOMOUS MODE]', async () => {
				await command.execute('plan my epic', undefined, { autoSwarm: true })

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.not.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)
			})
		})

		describe('--yolo shorthand', () => {
			it('should imply skip-permissions + autonomous + auto-swarm (via CLI resolution)', async () => {
				// --yolo is resolved in cli.ts to { oneShot: 'bypassPermissions', autoSwarm: true }
				// Here we test the PlanCommand with those resolved values
				let capturedHandlers: Map<string, HarnessHandler> = new Map()
				const mockHarnessInstance = {
					path: '/tmp/test-harness.sock',
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					registerHandler: vi.fn((type: string, handler: HarnessHandler) => {
						capturedHandlers.set(type, handler)
					}),
				}
				vi.mocked(HarnessServer).mockImplementation(
					() => mockHarnessInstance as unknown as HarnessServer
				)
				vi.mocked(mcpUtils.generateHarnessMcpConfig).mockReturnValue([
					{ mcpServers: { harness: {} } },
				])
				vi.mocked(claudeUtils.launchClaude).mockImplementation(async () => {
					const doneHandler = capturedHandlers.get('done')
					if (doneHandler) {
						await doneHandler({ epicIssueNumber: '42', childIssues: [1, 2, 3] })
					}
					return undefined
				})

				await command.execute('plan my epic', undefined, {
					oneShot: 'bypassPermissions',
					autoSwarm: true,
				})

				// Verify bypassPermissions
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
				// Verify autonomous wrapper
				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.stringContaining('[AUTONOMOUS MODE]'),
					expect.any(Object)
				)
				// Verify harness was created (auto-swarm)
				expect(HarnessServer).toHaveBeenCalled()
			})
		})

		describe('no flags set', () => {
			it('should not add bypassPermissions when no flags are set', async () => {
				await command.execute()

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					expect.any(String),
					expect.not.objectContaining({
						permissionMode: 'bypassPermissions',
					})
				)
			})

			it('should not modify prompt when no flags are set', async () => {
				const testPrompt = 'Help me plan a feature'

				await command.execute(testPrompt)

				expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
					testPrompt,
					expect.any(Object)
				)
			})

			it('should pass AUTONOMOUS_MODE: false in template variables', async () => {
				await command.execute()

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'plan',
					expect.objectContaining({
						AUTONOMOUS_MODE: false,
					})
				)
			})
		})

		describe('warning messages', () => {
			it('should log autonomous warning when oneShot=bypassPermissions is enabled', async () => {
				const { logger } = await import('../utils/logger.js')

				await command.execute('test prompt', undefined, { oneShot: 'bypassPermissions' })

				expect(logger.warn).toHaveBeenCalledWith(
					'Autonomous mode enabled - Claude will skip permission prompts and proceed without user interaction. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
				)
			})

			it('should log permission bypass warning when only dangerouslySkipPermissions is enabled', async () => {
				const { logger } = await import('../utils/logger.js')

				await command.execute('test prompt', undefined, { dangerouslySkipPermissions: true })

				expect(logger.warn).toHaveBeenCalledWith(
					'Permission bypass enabled - Claude will skip permission prompts. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
				)
			})
		})
	})

	describe('epic.planned telemetry', () => {
		const mockTrack = vi.fn()
		const mockGetChildIssues = vi.fn()

		beforeEach(() => {
			// Setup TelemetryService mock
			vi.mocked(TelemetryService.getInstance).mockReturnValue({ track: mockTrack } as unknown as TelemetryService)

			// Setup IssueManagementProviderFactory mock
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: mockGetChildIssues,
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockResolvedValue({ id: '42', title: 'Test epic', body: 'Epic body', state: 'open', url: '', provider: 'github', author: null }),
			} as never)

			// Setup decomposition mode: matchIssueIdentifier returns true for "42"
			vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '42',
			})

			// Setup IssueTrackerFactory.create to return a mock issue tracker
			const mockIssueTracker = {
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: '42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Test epic', body: 'Epic body' }),
			}
			vi.mocked(IssueTrackerFactory.create).mockReturnValue(mockIssueTracker as never)
		})

		it('tracks epic.planned with child_count after decomposition session', async () => {
			mockGetChildIssues.mockResolvedValue([
				{ id: '100', title: 'Child 1', state: 'open' },
				{ id: '101', title: 'Child 2', state: 'open' },
				{ id: '102', title: 'Child 3', state: 'open' },
			])

			await command.execute('42')

			expect(mockTrack).toHaveBeenCalledWith('epic.planned', {
				child_count: 3,
				tracker: 'github',
			})
		})

		it('does not track epic.planned for non-decomposition sessions', async () => {
			// Override: not an issue identifier
			vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({ isIssueIdentifier: false })

			await command.execute('help me plan something')

			expect(mockTrack).not.toHaveBeenCalledWith('epic.planned', expect.anything())
		})

		it('does not throw if telemetry tracking fails', async () => {
			// Make getChildIssues throw to trigger the catch block
			mockGetChildIssues.mockRejectedValue(new Error('MCP provider error'))

			// Should not throw — telemetry failure is non-blocking
			await expect(command.execute('42')).resolves.toBeUndefined()
		})
	})

	describe('auto-swarm harness lifecycle', () => {
		let capturedHandlers: Map<string, HarnessHandler>
		let mockHarnessInstance: {
			path: string
			start: ReturnType<typeof vi.fn>
			stop: ReturnType<typeof vi.fn>
			registerHandler: ReturnType<typeof vi.fn>
		}

		beforeEach(() => {
			capturedHandlers = new Map<string, HarnessHandler>()

			mockHarnessInstance = {
				path: '/tmp/test-harness.sock',
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				registerHandler: vi.fn((type: string, handler: HarnessHandler) => {
					capturedHandlers.set(type, handler)
				}),
			}

			vi.mocked(HarnessServer).mockImplementation(
				() => mockHarnessInstance as unknown as HarnessServer
			)

			// generateHarnessMcpConfig is synchronous — must use mockReturnValue
			vi.mocked(mcpUtils.generateHarnessMcpConfig).mockReturnValue([
				{ mcpServers: { harness: {} } },
			])

			// Default: launchClaude simulates successful planning by invoking the done handler
			vi.mocked(claudeUtils.launchClaude).mockImplementation(async () => {
				const doneHandler = capturedHandlers.get('done')
				if (doneHandler) {
					await doneHandler({ epicIssueNumber: '42', childIssues: [1, 2, 3] })
				}
				return undefined
			})
		})

		afterEach(() => {
			delete process.env.ILOOM_HARNESS_SOCKET
		})

		it('creates and starts HarnessServer when ILOOM_HARNESS_SOCKET is not set', async () => {
			delete process.env.ILOOM_HARNESS_SOCKET

			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(HarnessServer).toHaveBeenCalled()
			expect(mockHarnessInstance.start).toHaveBeenCalled()
		})

		it('does not create HarnessServer when ILOOM_HARNESS_SOCKET is set', async () => {
			process.env.ILOOM_HARNESS_SOCKET = '/tmp/external.sock'
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			// External harness mode: exits cleanly without checking epicData
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(HarnessServer).not.toHaveBeenCalled()
		})

		it('uses ILOOM_HARNESS_SOCKET path for harness MCP config', async () => {
			process.env.ILOOM_HARNESS_SOCKET = '/tmp/external.sock'
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			// External harness mode: exits cleanly, VS Code manages the pipeline
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(mcpUtils.generateHarnessMcpConfig).toHaveBeenCalledWith('/tmp/external.sock')
		})

		it('does not force bypassPermissions when only autoSwarm is true', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.not.objectContaining({ permissionMode: 'bypassPermissions' })
			)
		})

		it('includes harness signal tool in allowedTools for autoSwarm mode', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			const call = vi.mocked(claudeUtils.launchClaude).mock.calls[0]
			const options = call[1] as Record<string, unknown>
			expect(options.allowedTools).toEqual([
				'mcp__issue_management__get_issue',
				'mcp__issue_management__get_child_issues',
				'mcp__issue_management__create_issue',
				'mcp__issue_management__create_child_issue',
				'mcp__issue_management__create_comment',
				'mcp__issue_management__create_dependency',
				'mcp__issue_management__get_dependencies',
				'mcp__issue_management__remove_dependency',
				'mcp__harness__signal',
			])
		})

		it('sets AUTO_SWARM_MODE: true in template variables', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ AUTO_SWARM_MODE: true })
			)
		})

		it('passes AbortSignal to launchClaude', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			)
		})

		it('registers done handler on harness server', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(mockHarnessInstance.registerHandler).toHaveBeenCalledWith('done', expect.any(Function), { idempotent: true })
		})

		it('resolves successfully when done signal is received', async () => {
			await expect(
				command.execute('plan my epic', undefined, { autoSwarm: true })
			).resolves.toBeUndefined()
		})

		it('throws when launchClaude resolves without done signal', async () => {
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			await expect(
				command.execute('plan my epic', undefined, { autoSwarm: true })
			).rejects.toThrow('Plan phase exited without completing. The Architect did not signal done.')
		})

		it('stops harness server in finally block on success', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(mockHarnessInstance.stop).toHaveBeenCalled()
		})

		it('stops harness server in finally block when launchClaude throws', async () => {
			vi.mocked(claudeUtils.launchClaude).mockRejectedValue(new Error('Claude crashed'))

			await expect(
				command.execute('plan my epic', undefined, { autoSwarm: true })
			).rejects.toThrow('Claude crashed')

			expect(mockHarnessInstance.stop).toHaveBeenCalled()
		})

		it('done handler returns planning complete instruction', async () => {
			let doneResponse: unknown

			vi.mocked(claudeUtils.launchClaude).mockImplementation(async () => {
				const doneHandler = capturedHandlers.get('done')
				if (doneHandler) {
					doneResponse = await doneHandler({ epicIssueNumber: '42', childIssues: [1, 2, 3] })
				}
				return undefined
			})

			await command.execute('plan my epic', undefined, { autoSwarm: true })

			expect(doneResponse).toEqual({
				type: 'instruction',
				content: expect.stringContaining('Planning complete'),
			})
		})

		it('merges harness MCP config with base MCP config', async () => {
			await command.execute('plan my epic', undefined, { autoSwarm: true })

			// generateHarnessMcpConfig called with the harness socket path
			expect(mcpUtils.generateHarnessMcpConfig).toHaveBeenCalledWith(mockHarnessInstance.path)
		})
	})

	describe('body source-of-truth for plan decomposition', () => {
		beforeEach(() => {
			// Decomposition mode: matchIssueIdentifier returns true for "42"
			vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '42',
			})
		})

		it('uses mcpIssue.body as PARENT_ISSUE_BODY (already image-processed by MCP layer)', async () => {
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: '42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Test', body: 'raw-fetchIssue-body' }),
			} as never)
			const mockGetIssue = vi.fn().mockResolvedValue({
				id: '42',
				title: 'Test',
				body: 'mcp-processed-body',
				state: 'open',
				url: '',
				provider: 'github',
				author: null,
			})
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: mockGetIssue,
			} as never)

			await command.execute('42')

			expect(mockGetIssue).toHaveBeenCalledWith({ number: '42', includeComments: true })
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ PARENT_ISSUE_BODY: 'mcp-processed-body' })
			)
			// Source-of-truth comes from MCP, so the explicit fallback path is not used.
			expect(processMarkdownImages).not.toHaveBeenCalled()
		})

		it('preserves Linear attachment section appended by the MCP provider', async () => {
			const { SettingsManager } = await import('../lib/SettingsManager.js')
			vi.mocked(SettingsManager).mockImplementation(() => ({
				loadSettings: vi.fn().mockResolvedValue({ issueManagement: { provider: 'linear' } }),
				getPlanModel: vi.fn().mockReturnValue('opus'),
				getPlanPlanner: vi.fn().mockReturnValue('claude'),
				getPlanReviewer: vi.fn().mockReturnValue('none'),
				getPlanWaveVerification: vi.fn().mockReturnValue(true),
				getPlanEffort: vi.fn().mockReturnValue('high'),
			}) as unknown as InstanceType<typeof SettingsManager>)
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('linear')
			command = new PlanCommand(mockTemplateManager, mockAgentManager as unknown as AgentManager)

			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: 'ENG-42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 'ENG-42', title: 'Test', body: 'Original body' }),
			} as never)
			const mcpBodyWithAttachments = 'Original body\n\n## Attachments\n\n![screenshot](https://uploads.linear.app/abc.png)'
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockResolvedValue({
					id: 'ENG-42',
					title: 'Test',
					body: mcpBodyWithAttachments,
					state: 'open',
					url: '',
					provider: 'linear',
					author: null,
				}),
			} as never)

			await command.execute('ENG-42')

			const call = vi.mocked(mockTemplateManager.getPrompt).mock.calls.find(c => c[0] === 'plan')
			const body = (call?.[1] as { PARENT_ISSUE_BODY?: string } | undefined)?.PARENT_ISSUE_BODY ?? ''
			expect(body).toContain('## Attachments')
			expect(body).toContain('![screenshot](https://uploads.linear.app/abc.png)')
		})

		it('falls back to processMarkdownImages on raw body when MCP getIssue throws', async () => {
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
			const originalBody = 'body with image ![](https://github.com/user-attachments/assets/x.png)'
			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: '42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Test', body: originalBody }),
			} as never)
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockRejectedValue(new Error('MCP fetch failure')),
			} as never)
			vi.mocked(processMarkdownImages).mockResolvedValue('fallback-processed-body')

			await command.execute('42')

			expect(processMarkdownImages).toHaveBeenCalledWith(originalBody, 'github')
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ PARENT_ISSUE_BODY: 'fallback-processed-body' })
			)
		})

		it('falls back to raw body when both MCP getIssue and processMarkdownImages throw', async () => {
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
			const originalBody = 'body with image ![](https://github.com/user-attachments/assets/x.png)'
			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: '42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Test', body: originalBody }),
			} as never)
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockRejectedValue(new Error('MCP fetch failure')),
			} as never)
			vi.mocked(processMarkdownImages).mockRejectedValue(new Error('boom'))

			await command.execute('42')

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ PARENT_ISSUE_BODY: originalBody })
			)
		})
	})

	describe('comment fetching for plan decomposition', () => {
		beforeEach(() => {
			vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({
				isIssueIdentifier: true,
				type: 'numeric',
				identifier: '42',
			})
			vi.mocked(IssueTrackerFactory.getProviderName).mockReturnValue('github')
			vi.mocked(IssueTrackerFactory.create).mockReturnValue({
				detectInputType: vi.fn().mockResolvedValue({ type: 'issue', identifier: '42' }),
				fetchIssue: vi.fn().mockResolvedValue({ number: 42, title: 'Test', body: 'Body' }),
			} as never)
			vi.mocked(processMarkdownImages).mockImplementation(async (content: string) => content)
		})

		it('appends a Comments section to the body when MCP returns comments', async () => {
			const mockGetIssue = vi.fn().mockResolvedValue({
				id: '42',
				title: 'Test',
				body: 'Body',
				state: 'open',
				url: '',
				provider: 'github',
				author: null,
				comments: [
					{ id: 'c1', body: 'First comment', author: { id: 'u1', displayName: 'Alice' }, createdAt: '' },
					{ id: 'c2', body: 'Second comment', author: { id: 'u2', displayName: 'Bob' }, createdAt: '' },
				],
			})
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: mockGetIssue,
			} as never)

			await command.execute('42')

			expect(mockGetIssue).toHaveBeenCalledWith({ number: '42', includeComments: true })
			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({
					PARENT_ISSUE_BODY: expect.stringContaining('## Comments'),
				})
			)
			const call = vi.mocked(mockTemplateManager.getPrompt).mock.calls.find(c => c[0] === 'plan')
			const body = (call?.[1] as { PARENT_ISSUE_BODY?: string } | undefined)?.PARENT_ISSUE_BODY ?? ''
			expect(body).toContain('### Comment by Alice')
			expect(body).toContain('First comment')
			expect(body).toContain('### Comment by Bob')
			expect(body).toContain('Second comment')
		})

		it('omits the Comments section when MCP returns no comments', async () => {
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockResolvedValue({
					id: '42',
					title: 'Test',
					body: 'Body',
					state: 'open',
					url: '',
					provider: 'github',
					author: null,
					comments: [],
				}),
			} as never)

			await command.execute('42')

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ PARENT_ISSUE_BODY: 'Body' })
			)
		})

		it('continues with body-only context when MCP getIssue throws', async () => {
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: vi.fn().mockRejectedValue(new Error('MCP fetch failure')),
			} as never)

			await expect(command.execute('42')).resolves.toBeUndefined()

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ PARENT_ISSUE_BODY: 'Body' })
			)
		})

		it('passes includeComments: true to the MCP getIssue call', async () => {
			const mockGetIssue = vi.fn().mockResolvedValue({
				id: '42',
				title: 'Test',
				body: 'Body',
				state: 'open',
				url: '',
				provider: 'github',
				author: null,
			})
			vi.mocked(IssueManagementProviderFactory.create).mockReturnValue({
				getChildIssues: vi.fn().mockResolvedValue([]),
				getDependencies: vi.fn().mockResolvedValue({ blocking: [], blockedBy: [] }),
				getIssue: mockGetIssue,
			} as never)

			await command.execute('42')

			expect(mockGetIssue).toHaveBeenCalledWith(expect.objectContaining({ includeComments: true }))
		})
	})
})
