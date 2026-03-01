/* global AbortSignal */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlanCommand } from './plan.js'
import type { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import * as claudeUtils from '../utils/claude.js'
import * as mcpUtils from '../utils/mcp.js'
import * as firstRunSetup from '../utils/first-run-setup.js'
import { IssueManagementProviderFactory } from '../mcp/IssueManagementProviderFactory.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import * as identifierParser from '../utils/IdentifierParser.js'
import { IssueTrackerFactory } from '../lib/IssueTrackerFactory.js'
import { HarnessServer } from '../lib/HarnessServer.js'
import type { HarnessHandler } from '../lib/HarnessServer.js'

// Mock dependencies
vi.mock('../utils/claude.js')
vi.mock('../utils/mcp.js')
vi.mock('../utils/first-run-setup.js')
vi.mock('../utils/IdentifierParser.js')
vi.mock('../mcp/IssueManagementProviderFactory.js')
vi.mock('../lib/HarnessServer.js')
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

	beforeEach(() => {
		// Create mock template manager
		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('mocked plan prompt content'),
		} as unknown as PromptTemplateManager

		// Create command with mocked dependencies
		command = new PlanCommand(mockTemplateManager)

		// Setup default mocks
		vi.mocked(claudeUtils.detectClaudeCli).mockResolvedValue(true)
		vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)
		vi.mocked(mcpUtils.generateIssueManagementMcpConfig).mockResolvedValue([
			{ mcpServers: { issue_management: {} } },
		])
		// Default: project is already configured (no first-run setup needed)
		vi.mocked(firstRunSetup.needsFirstRunSetup).mockResolvedValue(false)
		vi.mocked(firstRunSetup.launchFirstRunSetup).mockResolvedValue(undefined)
		// Default: input is not an issue identifier (non-decomposition mode)
		vi.mocked(identifierParser.matchIssueIdentifier).mockReturnValue({ isIssueIdentifier: false })
		// Default: TelemetryService mock
		const mockTrack = vi.fn()
		vi.mocked(TelemetryService.getInstance).mockReturnValue({ track: mockTrack } as unknown as TelemetryService)
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
		it('should pass appendSystemPrompt with template content', async () => {
			const mockPromptContent = 'Test architect prompt content'
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					appendSystemPrompt: mockPromptContent,
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

		it('should pass allowedTools configuration', async () => {
			await command.execute()

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					allowedTools: expect.arrayContaining([
						'mcp__issue_management__create_issue',
						'mcp__issue_management__create_child_issue',
						'mcp__issue_management__get_issue',
						'Read',
						'Glob',
						'Grep',
					]),
				})
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

		it('should force yolo mode when print mode is enabled (AUTONOMOUS MODE prompt)', async () => {
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

		it('should not require prompt when print mode enables yolo', async () => {
			// Print mode with no prompt should work (unlike explicit --yolo which requires prompt)
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

		it('should force yolo even when explicit yolo=false is passed with print mode', async () => {
			// Print mode should override explicit yolo=false
			await command.execute('test prompt', undefined, false, undefined, undefined, { print: true })

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

	describe('yolo mode', () => {
		it('should add bypassPermissions when yolo is true', async () => {
			await command.execute('test prompt', undefined, true)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					permissionMode: 'bypassPermissions',
				})
			)
		})

		it('should not add bypassPermissions when yolo is false', async () => {
			await command.execute(undefined, undefined, false)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.not.objectContaining({
					permissionMode: 'bypassPermissions',
				})
			)
		})

		it('should structure prompt with AUTONOMOUS MODE and TOPIC sections when yolo is true', async () => {
			const testPrompt = 'Help me plan a feature'

			await command.execute(testPrompt, undefined, true)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[AUTONOMOUS MODE]'),
				expect.any(Object)
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining('[TOPIC]'),
				expect.any(Object)
			)
			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.stringContaining(testPrompt),
				expect.any(Object)
			)
		})

		it('should throw error when yolo is true but no prompt provided', async () => {
			await expect(command.execute(undefined, undefined, true)).rejects.toThrow(
				'--yolo requires a prompt or issue identifier'
			)
		})

		it('should not modify prompt when yolo is false', async () => {
			const testPrompt = 'Help me plan a feature'

			await command.execute(testPrompt, undefined, false)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				testPrompt,
				expect.any(Object)
			)
		})

		it('should log warning when yolo mode is enabled', async () => {
			const { logger } = await import('../utils/logger.js')

			await command.execute('test prompt', undefined, true)

			expect(logger.warn).toHaveBeenCalledWith(
				'YOLO mode enabled - Claude will skip permission prompts and proceed autonomously. This could destroy important data or make irreversible changes. Proceeding means you accept this risk.'
			)
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

			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(HarnessServer).toHaveBeenCalled()
			expect(mockHarnessInstance.start).toHaveBeenCalled()
		})

		it('does not create HarnessServer when ILOOM_HARNESS_SOCKET is set', async () => {
			process.env.ILOOM_HARNESS_SOCKET = '/tmp/external.sock'
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			// External harness mode: exits cleanly without checking epicData
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(HarnessServer).not.toHaveBeenCalled()
		})

		it('uses ILOOM_HARNESS_SOCKET path for harness MCP config', async () => {
			process.env.ILOOM_HARNESS_SOCKET = '/tmp/external.sock'
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			// External harness mode: exits cleanly, VS Code manages the pipeline
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(mcpUtils.generateHarnessMcpConfig).toHaveBeenCalledWith('/tmp/external.sock')
		})

		it('forces yolo mode (bypassPermissions) when autoSwarm is true', async () => {
			await command.execute('plan my epic', undefined, false, undefined, undefined, undefined, true)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ permissionMode: 'bypassPermissions' })
			)
		})

		it('adds mcp__harness__signal to allowed tools', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					allowedTools: expect.arrayContaining(['mcp__harness__signal']),
				})
			)
		})

		it('sets AUTO_SWARM_MODE: true in template variables', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
				'plan',
				expect.objectContaining({ AUTO_SWARM_MODE: true })
			)
		})

		it('passes AbortSignal to launchClaude', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(claudeUtils.launchClaude).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ signal: expect.any(AbortSignal) })
			)
		})

		it('registers done handler on harness server', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(mockHarnessInstance.registerHandler).toHaveBeenCalledWith('done', expect.any(Function), { idempotent: true })
		})

		it('resolves successfully when done signal is received', async () => {
			await expect(
				command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)
			).resolves.toBeUndefined()
		})

		it('throws when launchClaude resolves without done signal', async () => {
			vi.mocked(claudeUtils.launchClaude).mockResolvedValue(undefined)

			await expect(
				command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)
			).rejects.toThrow('Plan phase exited without completing. The Architect did not signal done.')
		})

		it('stops harness server in finally block on success', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(mockHarnessInstance.stop).toHaveBeenCalled()
		})

		it('stops harness server in finally block when launchClaude throws', async () => {
			vi.mocked(claudeUtils.launchClaude).mockRejectedValue(new Error('Claude crashed'))

			await expect(
				command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)
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

			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			expect(doneResponse).toEqual({
				type: 'instruction',
				content: expect.stringContaining('Planning complete'),
			})
		})

		it('merges harness MCP config with base MCP config', async () => {
			await command.execute('plan my epic', undefined, undefined, undefined, undefined, undefined, true)

			// generateHarnessMcpConfig called with the harness socket path
			expect(mcpUtils.generateHarnessMcpConfig).toHaveBeenCalledWith(mockHarnessInstance.path)
		})
	})
})
