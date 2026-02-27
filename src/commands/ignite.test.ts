import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IgniteCommand, WorktreeValidationError } from './ignite.js'
import type { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import type { SwarmSetupService } from '../lib/SwarmSetupService.js'
import * as claudeUtils from '../utils/claude.js'
import * as githubUtils from '../utils/github.js'
import * as gitUtils from '../utils/git.js'
import { MetadataManager } from '../lib/MetadataManager.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import * as languageDetector from '../utils/language-detector.js'
import * as systemPromptWriter from '../utils/system-prompt-writer.js'

// Mock TelemetryService
vi.mock('../lib/TelemetryService.js', () => {
	const mockTrack = vi.fn()
	return {
		TelemetryService: {
			getInstance: vi.fn(() => ({
				track: mockTrack,
			})),
			resetInstance: vi.fn(),
		},
	}
})

// Mock detectProjectLanguage
vi.mock('../utils/language-detector.js', () => ({
	detectProjectLanguage: vi.fn().mockResolvedValue('typescript'),
}))

// Mock MetadataManager to return proper metadata for recap MCP tests
vi.mock('../lib/MetadataManager.js', () => ({
	MetadataManager: vi.fn(() => ({
		readMetadata: vi.fn().mockResolvedValue({
			description: 'Test loom',
			created_at: '2025-01-01T00:00:00Z',
			branchName: 'feat/test-branch',
			worktreePath: '/path/to/workspace',
			issueType: 'issue',
			issue_numbers: ['123'],
			databaseBranchName: null,
			parentLoomBranch: null,
			sessionId: '12345678-1234-4567-8901-123456789012', // Required for spin command
		}),
		getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
		updateMetadata: vi.fn().mockResolvedValue(undefined),
	})),
}))

// Mock SwarmSetupService for swarm mode tests
vi.mock('../lib/SwarmSetupService.js', () => ({
	SwarmSetupService: vi.fn(() => ({
		setupSwarm: vi.fn().mockResolvedValue({
			epicWorktreePath: '/path/to/epic',
			epicBranch: 'feat/epic-branch',
			childWorktrees: [
				{ issueId: '101', worktreePath: '/path/to/child-101', branch: 'feat/issue-101', success: true },
				{ issueId: '102', worktreePath: '/path/to/child-102', branch: 'feat/issue-102', success: true },
			],
			agentsRendered: [],
			workerAgentRendered: false,
		}),
	})),
}))

describe('IgniteCommand', () => {
	let command: IgniteCommand
	let mockTemplateManager: PromptTemplateManager
	let mockGitWorktreeManager: GitWorktreeManager

	beforeEach(() => {
		// Re-set language detector mock (mockReset clears return values between tests)
		vi.mocked(languageDetector.detectProjectLanguage).mockResolvedValue('typescript')

		// Mock dependencies
		mockTemplateManager = {
			getPrompt: vi.fn().mockResolvedValue('mocked prompt content'),
		} as unknown as PromptTemplateManager

		mockGitWorktreeManager = {
			getRepoInfo: vi.fn().mockResolvedValue({
				currentBranch: 'feat/issue-70__test-branch',
			}),
		} as unknown as GitWorktreeManager

		// Create command with mocked dependencies
		command = new IgniteCommand(
			mockTemplateManager,
			mockGitWorktreeManager
		)
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	describe('Context Auto-Detection from Directory Name', () => {
		it('should detect issue workflow from directory name pattern: feat/issue-70__description', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock process.cwd() to return directory with issue- pattern
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-70__description')

			try {
				await command.execute()

				// Verify launchClaude was called with correct options
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String), // prompt
					expect.objectContaining({
						headless: false,
						addDir: '/path/to/feat/issue-70__description',
						model: 'opus',
						permissionMode: 'acceptEdits',
					})
				)

				// Verify template manager was called with correct type and variables
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/feat/issue-70__description',
						ISSUE_NUMBER: "70",
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should detect PR workflow from directory name pattern: _pr_123', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock process.cwd() to return directory with _pr_ suffix
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature-branch_pr_123')

			try {
				await command.execute()

				// Verify launchClaude was called with correct options (PR uses default model)
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String), // prompt
					expect.objectContaining({
						headless: false,
						addDir: '/path/to/feature-branch_pr_123',
						// PR workflow doesn't have model or permissionMode overrides
					})
				)

				// Verify template manager was called with PR type
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'pr',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/feature-branch_pr_123',
						PR_NUMBER: 123,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should detect issue workflow from git branch name when directory does not match', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock process.cwd() to return non-matching directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/some-worktree')

			// Mock git branch to return issue pattern
			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'feat/issue-45__another-test',
			})

			try {
				await command.execute()

				// Verify launchClaude was called with correct options
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: false,
						addDir: '/path/to/some-worktree',
						model: 'opus',
						permissionMode: 'acceptEdits',
					})
				)

				// Verify template manager was called
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ISSUE_NUMBER: "45",
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should fallback to regular workflow when no patterns match', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock process.cwd() to return non-matching directory
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			// Mock git branch to return non-matching branch
			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			try {
				await command.execute()

				// Verify launchClaude was called (regular workflow uses defaults)
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: false,
						addDir: '/path/to/main',
						// Regular workflow doesn't override model or permissionMode
					})
				)

				// Verify template manager was called with regular type
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'regular',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/main',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should calculate PORT for web-capable looms from metadata', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return web capability
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-99__port-test',
					worktreePath: '/path/to/feat/issue-99__port-test',
					issueType: 'issue',
					issue_numbers: ['99'],
					capabilities: ['web'], // Web capability triggers PORT calculation
					sessionId: '12345678-1234-4567-8901-123456789012',
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock process.cwd()
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-99__port-test')

			try {
				await command.execute()

				// Verify template manager was called with PORT calculated from issue number (3000 + 99 = 3099)
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						PORT: 3099,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should not include PORT for looms without web capability', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Default mock metadata has no capabilities, so PORT should not be set

			// Mock process.cwd()
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-88__no-port')

			try {
				await command.execute()

				// Verify template manager was called without PORT (no web capability)
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[0]).toBe('issue')
				expect(templateCall[1].PORT).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('Claude CLI Launch Configuration', () => {
		it('should use correct workflow type and model/permission settings', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__test')

			try {
				await command.execute()

				// Verify launchClaude was called with issue workflow settings
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: false,
						model: 'opus',
						permissionMode: 'acceptEdits',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass workspace directory as addDir', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const workspacePath = '/workspace/feat/issue-42__workspace'
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue(workspacePath)

			try {
				await command.execute()

				// Verify addDir is passed correctly
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						addDir: workspacePath,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should include branch name in Claude options', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-33__branch-test')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'feat/issue-33__branch-test',
			})

			try {
				await command.execute()

				// Verify branchName is included
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						branchName: 'feat/issue-33__branch-test',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('Print mode (--print flag)', () => {
		it('should call launchClaude with headless=true when print option is enabled', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-test')

			try {
				await command.execute(undefined, { print: true })

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: true,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should force bypassPermissions when print mode is enabled', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-test')

			try {
				await command.execute(undefined, { print: true })

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: true,
						permissionMode: 'bypassPermissions',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should forward outputFormat to launchClaude when provided', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-test')

			try {
				await command.execute(undefined, { print: true, outputFormat: 'json' })

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: true,
						outputFormat: 'json',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should forward verbose to launchClaude when provided', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-test')

			try {
				await command.execute(undefined, { print: true, verbose: false })

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headless: true,
						verbose: false,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should not set outputFormat or verbose when print mode is disabled', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__test')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].headless).toBe(false)
				expect(launchClaudeCall[1].outputFormat).toBeUndefined()
				expect(launchClaudeCall[1].verbose).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should force noReview oneShot mode when print mode is enabled', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-noreview')

			try {
				// Execute with print mode enabled - should force noReview behavior
				await command.execute(undefined, { print: true })

				// Verify the user prompt includes approval bypass instructions (noReview behavior)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				expect(userPrompt).toContain('without awaiting confirmation')
				expect(userPrompt).toContain('This supersedes any other guidance')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should force noReview oneShot mode even when explicit default oneShot is passed with print mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-override')

			try {
				// Execute with explicit 'default' oneShot but print mode - print should win
				await command.execute('default', { print: true })

				// Verify the user prompt includes approval bypass instructions (noReview behavior)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				expect(userPrompt).toContain('without awaiting confirmation')
				expect(userPrompt).toContain('This supersedes any other guidance')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass ONE_SHOT_MODE=true to template manager when print mode is enabled', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__print-template')

			try {
				await command.execute(undefined, { print: true })

				// Verify template manager was called with ONE_SHOT_MODE=true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ONE_SHOT_MODE: true,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('VS Code mode detection', () => {
		it('should pass IS_VSCODE_MODE: true when ILOOM_VSCODE=1', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__vscode-test')

			const originalEnv = process.env.ILOOM_VSCODE
			process.env.ILOOM_VSCODE = '1'

			try {
				await command.execute()

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						IS_VSCODE_MODE: true,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				if (originalEnv === undefined) {
					delete process.env.ILOOM_VSCODE
				} else {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})

		it('should pass IS_VSCODE_MODE: false when ILOOM_VSCODE is not set', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__vscode-test')

			const originalEnv = process.env.ILOOM_VSCODE
			delete process.env.ILOOM_VSCODE

			try {
				await command.execute()

				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						IS_VSCODE_MODE: false,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				if (originalEnv !== undefined) {
					process.env.ILOOM_VSCODE = originalEnv
				}
			}
		})
	})

	describe('Error Handling', () => {
		it('should handle git command failures gracefully', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock git failure
			mockGitWorktreeManager.getRepoInfo = vi
				.fn()
				.mockRejectedValue(new Error('Not a git repository'))

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/non-git-dir')

			try {
				await command.execute()

				// Should fallback to regular workflow
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'regular',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/non-git-dir',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should propagate Claude launch errors', async () => {
			// Spy on launchClaude and make it fail
			const launchClaudeSpy = vi
				.spyOn(claudeUtils, 'launchClaude')
				.mockRejectedValue(new Error('Claude CLI not found'))

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/workspace')

			try {
				await expect(command.execute()).rejects.toThrow('Claude CLI not found')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('Terminal Behavior - Expected behavior for il ignite', () => {
		it('should call launchClaude directly with stdio inherit, not open new terminal window', async () => {
			// EXPECTED BEHAVIOR for il ignite:
			// 1. Detect workspace context (issue/PR/regular)
			// 2. Get prompt template with variable substitution
			// 3. Call launchClaude() utility directly with:
			//    - headless: false (to enable stdio: 'inherit')
			//    - model: appropriate for workflow type (e.g., 'claude-sonnet-4-20250514' for issues)
			//    - permissionMode: appropriate for workflow type (e.g., 'acceptEdits' for issues)
			//    - addDir: workspace path
			//
			// This will make Claude run in the CURRENT terminal, not open a new window
			//
			// CURRENT INCORRECT BEHAVIOR:
			// Currently calls ClaudeService.launchForWorkflow() with headless: false
			// which routes to launchClaudeInNewTerminalWindow(), opening a NEW terminal
			//
			// WHY THIS TEST WILL FAIL:
			// The current implementation in IgniteCommand.execute() calls:
			//   await this.claudeService.launchForWorkflow(context)
			// which with headless: false goes to launchClaudeInNewTerminalWindow()
			//
			// WHAT NEEDS TO CHANGE:
			// IgniteCommand should bypass launchForWorkflow and call launchClaude directly

			// Spy on the launchClaude utility function
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude')
			const launchClaudeInNewTerminalWindowSpy = vi.spyOn(claudeUtils, 'launchClaudeInNewTerminalWindow')

			launchClaudeSpy.mockResolvedValue(undefined)
			launchClaudeInNewTerminalWindowSpy.mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__terminal-test')

			try {
				await command.execute()

				// EXPECTED: launchClaude should be called with headless: false and stdio: 'inherit'
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					expect.any(String), // prompt
					expect.objectContaining({
						headless: false,
						addDir: '/path/to/feat/issue-50__terminal-test',
						model: 'opus', // issue workflow model (default from spin.model)
						permissionMode: 'acceptEdits', // issue workflow permission mode
					})
				)

				// EXPECTED: launchClaudeInNewTerminalWindow should NOT be called
				expect(launchClaudeInNewTerminalWindowSpy).not.toHaveBeenCalled()

				// This test will FAIL because:
				// 1. launchClaude is NOT called (current implementation doesn't call it)
				// 2. launchClaudeInNewTerminalWindow IS called (via launchForWorkflow)
				//
				// To verify the current behavior, uncomment these lines:
				// expect(launchClaudeSpy).not.toHaveBeenCalled() // passes - launchClaude NOT called
				// expect(launchClaudeInNewTerminalWindowSpy).toHaveBeenCalled() // passes - new terminal opened
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				launchClaudeInNewTerminalWindowSpy.mockRestore()
			}
		})
	})

	describe('Edge Cases', () => {
		it('should handle directory names with multiple issue patterns (use first match)', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/issue-10-and-issue-20-combined')

			try {
				await command.execute()

				// Should detect first issue number
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ISSUE_NUMBER: "10",
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should prioritize directory pattern over branch pattern', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__dir')

			// Branch has different issue number
			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'feat/issue-200__branch',
			})

			try {
				await command.execute()

				// Should use directory pattern (100), not branch (200)
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ISSUE_NUMBER: "100",
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should handle branch name with no current branch', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/workspace')

			// Mock getRepoInfo to return null branch
			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: null,
			})

			try {
				await command.execute()

				// Should fallback to regular workflow
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'regular',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/workspace',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('appendSystemPrompt usage in il ignite', () => {
		it('should pass template content as appendSystemPrompt for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-82__test')

			// Mock template manager to return known content
			mockTemplateManager.getPrompt = vi.fn().mockResolvedValue('System instructions for issue workflow')

			try {
				await command.execute()

				// Verify launchClaude was called with appendSystemPrompt
				expect(launchClaudeSpy).toHaveBeenCalledWith(
					'Guide the user through the iloom workflow!', // User prompt
					expect.objectContaining({
						headless: false,
						model: 'opus',
						permissionMode: 'acceptEdits',
						appendSystemPrompt: 'System instructions for issue workflow',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass template content as appendSystemPrompt for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_123')

			mockTemplateManager.getPrompt = vi.fn().mockResolvedValue('System instructions for PR workflow')

			try {
				await command.execute()

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					'Guide the user through the iloom workflow!',
					expect.objectContaining({
						headless: false,
						appendSystemPrompt: 'System instructions for PR workflow',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass template content as appendSystemPrompt for regular workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			mockTemplateManager.getPrompt = vi.fn().mockResolvedValue('System instructions for regular workflow')

			try {
				await command.execute()

				expect(launchClaudeSpy).toHaveBeenCalledWith(
					'Guide the user through the iloom workflow!',
					expect.objectContaining({
						headless: false,
						appendSystemPrompt: 'System instructions for regular workflow',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('MCP Configuration', () => {
		it('should generate MCP config for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-77__mcp-test')

			try {
				await command.execute()

				// Verify launchClaude was called with mcpConfig
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('mcpConfig')
				expect(launchClaudeCall[1].mcpConfig).toBeInstanceOf(Array)
				expect(launchClaudeCall[1].mcpConfig.length).toBeGreaterThan(0)

				// Verify MCP config structure
				const mcpConfig = launchClaudeCall[1].mcpConfig[0]
				expect(mcpConfig).toHaveProperty('mcpServers')
				expect(mcpConfig.mcpServers).toHaveProperty('issue_management')
				expect(mcpConfig.mcpServers.issue_management).toHaveProperty('command')
				expect(mcpConfig.mcpServers.issue_management).toHaveProperty('args')
				expect(mcpConfig.mcpServers.issue_management).toHaveProperty('env')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should generate MCP config for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_456')

			try {
				await command.execute()

				// Verify launchClaude was called with mcpConfig
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('mcpConfig')
				expect(launchClaudeCall[1].mcpConfig).toBeInstanceOf(Array)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should generate recap MCP config for regular workflows (not issue_management)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			try {
				await command.execute()

				// Verify launchClaude was called with recap MCP config (but not issue_management)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].mcpConfig).toBeInstanceOf(Array)
				expect(launchClaudeCall[1].mcpConfig).toHaveLength(1)
				// Recap MCP should be present
				expect(launchClaudeCall[1].mcpConfig[0].mcpServers).toHaveProperty('recap')
				// Issue management MCP should NOT be present for regular workflows
				expect(launchClaudeCall[1].mcpConfig[0].mcpServers).not.toHaveProperty('issue_management')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should include correct environment variables in MCP config for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-88__env-test')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const mcpConfig = launchClaudeCall[1].mcpConfig[0]
				const env = mcpConfig.mcpServers.issue_management.env

				expect(env).toHaveProperty('ISSUE_PROVIDER', 'github')
				expect(env).toHaveProperty('REPO_OWNER')
				expect(env).toHaveProperty('REPO_NAME')
				expect(env).toHaveProperty('GITHUB_EVENT_NAME', 'issues')
				expect(env).toHaveProperty('GITHUB_API_URL')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should include correct environment variables in MCP config for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_789')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const mcpConfig = launchClaudeCall[1].mcpConfig[0]
				const env = mcpConfig.mcpServers.issue_management.env

				expect(env).toHaveProperty('ISSUE_PROVIDER', 'github')
				expect(env).toHaveProperty('GITHUB_EVENT_NAME', 'pull_request')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})
	})

	describe('Tool Filtering for Issue/PR Workflows', () => {
		it('should pass allowedTools to launchClaude for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-84__test')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('allowedTools')
				// For issue workflows, set_goal is excluded (issue title provides context)
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
					'mcp__issue_management__create_issue',
					'mcp__issue_management__close_issue',
					'mcp__issue_management__reopen_issue',
					'mcp__issue_management__edit_issue',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
					'mcp__recap__set_loom_state',
					'mcp__recap__get_loom_state',
				])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should pass disallowedTools to launchClaude for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-84__test')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('disallowedTools')
				// Issue workflows block gh api (no need for PR review comments) and gh issue comment
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*)', 'Bash(gh issue comment:*)'])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should pass allowedTools to launchClaude for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_456')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('allowedTools')
				// For PR workflows, get_pr, get_review_comments, and set_goal are included (user's purpose unclear)
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
					'mcp__issue_management__create_issue',
					'mcp__issue_management__close_issue',
					'mcp__issue_management__reopen_issue',
					'mcp__issue_management__edit_issue',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
					'mcp__recap__set_loom_state',
					'mcp__recap__get_loom_state',
					'mcp__issue_management__get_pr',
					'mcp__issue_management__get_review_comments',
					'mcp__recap__set_goal',
				])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should pass disallowedTools to launchClaude for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_456')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('disallowedTools')
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh issue comment:*)'])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should pass recap tools for regular workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				// Regular workflows should allow recap tools (including set_goal since no issue/PR context)
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__recap__set_goal',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__set_complexity',
					'mcp__recap__set_loom_state',
					'mcp__recap__get_loom_state',
				])
				expect(launchClaudeCall[1].disallowedTools).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should combine tool filtering with mcpConfig for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-84__combined')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				// Verify both mcpConfig and tool filtering are present
				expect(launchClaudeCall[1]).toHaveProperty('mcpConfig')
				expect(launchClaudeCall[1]).toHaveProperty('allowedTools')
				expect(launchClaudeCall[1]).toHaveProperty('disallowedTools')
				expect(launchClaudeCall[1].mcpConfig).toBeInstanceOf(Array)
				// For issue workflows, set_goal is excluded (issue title provides context)
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
					'mcp__issue_management__create_issue',
					'mcp__issue_management__close_issue',
					'mcp__issue_management__reopen_issue',
					'mcp__issue_management__edit_issue',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
					'mcp__recap__set_loom_state',
					'mcp__recap__get_loom_state',
				])
				// Issue workflows block gh api (no need for PR review comments) and gh issue comment
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*)', 'Bash(gh issue comment:*)'])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should include mcp__issue_management__get_pr and get_review_comments in allowedTools for PR workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feature_pr_789')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].allowedTools).toContain('mcp__issue_management__get_pr')
				expect(launchClaudeCall[1].allowedTools).toContain('mcp__issue_management__get_review_comments')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should NOT include mcp__issue_management__get_pr or get_review_comments in allowedTools for issue workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].allowedTools).not.toContain('mcp__issue_management__get_pr')
				expect(launchClaudeCall[1].allowedTools).not.toContain('mcp__issue_management__get_review_comments')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})
	})

	describe('agent loading', () => {
		it('should load agents for issue workflow', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			// Create command with mock agent manager
			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				// Verify agents were loaded and passed to launchClaude
				expect(mockAgentManager.loadAgents).toHaveBeenCalled()
				expect(mockAgentManager.formatForCli).toHaveBeenCalled()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('agents')
				expect(launchClaudeCall[1].agents).toEqual({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				})
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should load agents for PR workflow', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'pr-agent': {
						description: 'PR agent',
						prompt: 'PR prompt',
						tools: ['Read', 'Write'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__pr-456')
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				expect(mockAgentManager.loadAgents).toHaveBeenCalled()
				expect(mockAgentManager.formatForCli).toHaveBeenCalled()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('agents')
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should load agents for regular workflow', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'regular-agent': {
						description: 'Regular agent',
						prompt: 'Regular prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/some-other-branch')
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				expect(mockAgentManager.loadAgents).toHaveBeenCalled()
				expect(mockAgentManager.formatForCli).toHaveBeenCalled()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('agents')
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should handle agent loading failure gracefully', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

			const mockAgentManager = {
				loadAgents: vi.fn().mockRejectedValue(new Error('Failed to load agents')),
				formatForCli: vi.fn(),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				// Should not throw - execution continues without agents
				await commandWithAgents.execute()

				expect(mockAgentManager.loadAgents).toHaveBeenCalled()
				expect(mockAgentManager.formatForCli).not.toHaveBeenCalled()

				// Verify Claude was still launched (without agents)
				expect(launchClaudeSpy).toHaveBeenCalled()
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].agents).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				consoleWarnSpy.mockRestore()
			}
		})

		it('should combine agents with existing MCP config and tool filtering', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'combined-agent': {
						description: 'Combined test agent',
						prompt: 'Combined prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-99__combined')
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				// Verify all three are present: mcpConfig, tool filtering, and agents
				expect(launchClaudeCall[1]).toHaveProperty('mcpConfig')
				expect(launchClaudeCall[1]).toHaveProperty('allowedTools')
				expect(launchClaudeCall[1]).toHaveProperty('disallowedTools')
				expect(launchClaudeCall[1]).toHaveProperty('agents')

				expect(launchClaudeCall[1].agents).toEqual({
					'combined-agent': {
						description: 'Combined test agent',
						prompt: 'Combined prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				})
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})
	})

	describe('platform-specific agent and system prompt handling', () => {
		it('should render agents to disk on Linux instead of passing to launchClaude', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue(['test-agent.md']),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')
			const originalPlatform = process.platform

			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				// Verify renderAgentsToDisk was called instead of formatForCli
				expect(mockAgentManager.renderAgentsToDisk).toHaveBeenCalledWith(
					expect.objectContaining({ 'test-agent': expect.any(Object) }),
					'/path/to/feat/issue-123__test/.claude/agents',
				)
				expect(mockAgentManager.formatForCli).not.toHaveBeenCalled()

				// Verify agents is NOT passed to launchClaude
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].agents).toBeUndefined()

				// Verify system prompt is still passed inline (Linux uses appendSystemPrompt)
				expect(launchClaudeCall[1].appendSystemPrompt).toBeDefined()
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should use plugin-dir and /clear prompt on Windows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			// Mock prepareSystemPromptForPlatform to return Windows-style config
			const prepareSystemPromptSpy = vi.spyOn(systemPromptWriter, 'prepareSystemPromptForPlatform').mockResolvedValue({
				pluginDir: '/path/to/feat/issue-123__test/.claude/iloom-plugin',
				initialPromptOverride: '/clear',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue(['test-agent.md']),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')
			const originalPlatform = process.platform

			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				// Verify renderAgentsToDisk was called (non-darwin platform)
				expect(mockAgentManager.renderAgentsToDisk).toHaveBeenCalled()
				expect(mockAgentManager.formatForCli).not.toHaveBeenCalled()

				// Verify launchClaude uses plugin-dir and /clear prompt
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[0]).toBe('/clear') // initial prompt override
				expect(launchClaudeCall[1].pluginDir).toBe('/path/to/feat/issue-123__test/.claude/iloom-plugin')
				expect(launchClaudeCall[1].appendSystemPrompt).toBeUndefined()
				expect(launchClaudeCall[1].agents).toBeUndefined()
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
				prepareSystemPromptSpy.mockRestore()
			}
		})

		it('should use formatForCli and inline agents on macOS (unchanged behavior)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			// Ensure we're on darwin (tests run on macOS)
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			const commandWithAgents = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
			)

			try {
				await commandWithAgents.execute()

				// Verify formatForCli was called (darwin path)
				expect(mockAgentManager.formatForCli).toHaveBeenCalled()
				expect(mockAgentManager.renderAgentsToDisk).not.toHaveBeenCalled()

				// Verify agents ARE passed to launchClaude
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].agents).toBeDefined()
				expect(launchClaudeCall[1].appendSystemPrompt).toBeDefined()
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})
	})

	describe('settings integration', () => {
		it('should load settings and pass to AgentManager', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockSettings = {
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue(mockSettings),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'haiku', // Should be overridden
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			const commandWithSettings = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			try {
				await commandWithSettings.execute()

				// Verify settings were loaded
				expect(mockSettingsManager.loadSettings).toHaveBeenCalled()

				// Verify settings and template variables were passed to loadAgents
				expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
					mockSettings,
					expect.objectContaining({
						ISSUE_NUMBER: '123',
						WORKSPACE_PATH: '/path/to/feat/issue-123__test',
					}),
					['*.md', '!iloom-framework-detector.md']
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should handle missing settings gracefully and continue', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({}), // Empty settings
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			const commandWithSettings = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			try {
				await commandWithSettings.execute()

				// Should still execute successfully
				expect(mockSettingsManager.loadSettings).toHaveBeenCalled()
				// loadAgents receives empty settings and template variables
				expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(
					{},
					expect.objectContaining({
						ISSUE_NUMBER: '123',
						WORKSPACE_PATH: '/path/to/feat/issue-123__test',
					}),
					['*.md', '!iloom-framework-detector.md']
				)
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should throw when settings loading fails', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockSettingsManager = {
				loadSettings: vi.fn().mockRejectedValue(new Error('Failed to load settings')),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'sonnet',
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			const commandWithSettings = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			try {
				// Settings are pre-validated at CLI startup, so errors should propagate
				await expect(commandWithSettings.execute()).rejects.toThrow('Failed to load settings')

				expect(mockSettingsManager.loadSettings).toHaveBeenCalled()
				// loadAgents should not be called since settings loading failed
				expect(mockAgentManager.loadAgents).not.toHaveBeenCalled()
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should pass merged agent configs to Claude CLI', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockSettings = {
				agents: {
					'test-agent': {
						model: 'haiku',
					},
				},
			}

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue(mockSettings),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'haiku', // Overridden by settings
					},
				}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')
			const originalPlatform = process.platform
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

			const commandWithSettings = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			try {
				await commandWithSettings.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('agents')
				expect(launchClaudeCall[1].agents).toEqual({
					'test-agent': {
						description: 'Test agent',
						prompt: 'Test prompt',
						tools: ['Read'],
						model: 'haiku', // Should reflect the override
					},
				})
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should include review template variables in prompt when agents have review config', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const getRepoInfoSpy = vi.spyOn(githubUtils, 'getRepoInfo').mockResolvedValue({
				owner: 'testowner',
				name: 'testrepo',
			})

			const mockSettings = {
				agents: {
					'iloom-artifact-reviewer': {
						enabled: true,
						providers: {
							claude: 'opus',
							gemini: 'gemini-3-pro',
						},
					},
					'iloom-issue-planner': { review: true },
					'iloom-issue-analyzer': { review: true },
				},
			}

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue(mockSettings),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

			const commandWithReview = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			try {
				await commandWithReview.execute()

				// Verify template manager received review variables
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						REVIEW_ENABLED: true,
						ARTIFACT_REVIEW_ENABLED: true,
						HAS_ARTIFACT_REVIEW_CLAUDE: true,
						HAS_ARTIFACT_REVIEW_GEMINI: true,
						ARTIFACT_REVIEW_CLAUDE_MODEL: 'opus',
						ARTIFACT_REVIEW_GEMINI_MODEL: 'gemini-3-pro',
						PLANNER_REVIEW_ENABLED: true,
						ANALYZER_REVIEW_ENABLED: true,
						ENHANCER_REVIEW_ENABLED: false,
						IMPLEMENTER_REVIEW_ENABLED: false,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})
	})

	describe('One-Shot Mode User Prompt Generation', () => {
		it('should use approval bypass prompt for oneShot=noReview mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__oneshot')

			try {
				// Execute with noReview one-shot mode
				await command.execute('noReview')

				// Verify the user prompt includes approval bypass instructions
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				// Should include approval bypass text to override template requirements
				expect(userPrompt).toContain('Guide the user through the iloom workflow!')
				expect(userPrompt).toContain('without awaiting confirmation')
				expect(userPrompt).toContain('This supersedes any other guidance')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use approval bypass prompt for oneShot=bypassPermissions mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__oneshot')

			try {
				// Execute with bypassPermissions one-shot mode
				await command.execute('bypassPermissions')

				// Verify the user prompt includes approval bypass instructions
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				// Should include approval bypass text to override template requirements
				expect(userPrompt).toContain('Guide the user through the iloom workflow!')
				expect(userPrompt).toContain('without awaiting confirmation')
				expect(userPrompt).toContain('This supersedes any other guidance')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use simple "Go!" prompt for default mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__regular')

			try {
				// Execute without one-shot mode (default)
				await command.execute('default')

				// Verify the user prompt is the standard workflow prompt
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				// Should be simple workflow prompt without extra instructions
				expect(userPrompt).toBe('Guide the user through the iloom workflow!')
				expect(userPrompt).not.toContain('Answer Table')
				expect(userPrompt).not.toContain('one-shot mode')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use simple "Go!" prompt when no oneShot option is provided', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__regular')

			try {
				// Execute without any oneShot option
				await command.execute()

				// Verify the user prompt is the standard workflow prompt
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]

				// Should be simple workflow prompt without extra instructions
				expect(userPrompt).toBe('Guide the user through the iloom workflow!')
				expect(userPrompt).not.toContain('Answer Table')
				expect(userPrompt).not.toContain('one-shot mode')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass ONE_SHOT_MODE flag to template manager for noReview mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__oneshot')

			try {
				await command.execute('noReview')

				// Verify template manager was called with ONE_SHOT_MODE=true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ONE_SHOT_MODE: true,
					})
				)

				// Verify answer table instructions are included in appendSystemPrompt
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should pass ONE_SHOT_MODE flag to template manager for bypassPermissions mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__oneshot')

			try {
				await command.execute('bypassPermissions')

				// Verify template manager was called with ONE_SHOT_MODE=true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ONE_SHOT_MODE: true,
					})
				)

				// Verify answer table instructions are included in appendSystemPrompt
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should NOT pass ONE_SHOT_MODE flag for default mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__regular')

			try {
				await command.execute('default')

				// Verify template manager was called without ONE_SHOT_MODE
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1].ONE_SHOT_MODE).toBeUndefined()

				// Verify answer table instructions are STILL included in appendSystemPrompt (proving unconditional behavior)
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('One-Shot Mode Metadata Priority', () => {
		it('should use explicit flag over stored metadata oneShot value', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with oneShot: 'noReview'
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-496__test',
					worktreePath: '/path/to/feat/issue-496__test',
					issueType: 'issue',
					issue_numbers: ['496'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					oneShot: 'noReview', // Stored metadata value
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			const commandWithMetadataOneShot = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-496__test')

			try {
				// Execute with explicit 'bypassPermissions' flag (should override stored 'noReview')
				await commandWithMetadataOneShot.execute('bypassPermissions')

				// Verify permission mode reflects the explicit flag, not the stored value
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].permissionMode).toBe('bypassPermissions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use stored metadata oneShot when flag is undefined (not passed)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with oneShot: 'noReview'
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-496__test',
					worktreePath: '/path/to/feat/issue-496__test',
					issueType: 'issue',
					issue_numbers: ['496'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					oneShot: 'noReview', // Stored metadata value
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			const commandWithMetadataOneShot = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-496__test')

			try {
				// Execute with undefined (flag not passed) - should use stored 'noReview'
				await commandWithMetadataOneShot.execute(undefined)

				// Verify the user prompt uses noReview behavior (approval bypass)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]
				expect(userPrompt).toContain('without awaiting confirmation')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use explicit default flag over stored metadata oneShot', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with oneShot: 'noReview'
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-496__test',
					worktreePath: '/path/to/feat/issue-496__test',
					issueType: 'issue',
					issue_numbers: ['496'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					oneShot: 'noReview', // Stored metadata value
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			const commandWithMetadataOneShot = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-496__test')

			try {
				// Execute with explicit 'default' flag (should override stored 'noReview' and use 'default')
				await commandWithMetadataOneShot.execute('default')

				// Verify the user prompt uses default behavior (no approval bypass)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]
				expect(userPrompt).toBe('Guide the user through the iloom workflow!')
				expect(userPrompt).not.toContain('without awaiting confirmation')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use stored bypassPermissions from metadata when flag is undefined (not passed)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with oneShot: 'bypassPermissions'
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-496__test',
					worktreePath: '/path/to/feat/issue-496__test',
					issueType: 'issue',
					issue_numbers: ['496'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					oneShot: 'bypassPermissions', // Stored metadata value
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			const commandWithMetadataOneShot = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-496__test')

			try {
				// Execute with undefined (flag not passed) - should use stored 'bypassPermissions'
				await commandWithMetadataOneShot.execute(undefined)

				// Verify permission mode is set to bypassPermissions from stored metadata
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].permissionMode).toBe('bypassPermissions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use default when no stored value and no explicit flag', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata without oneShot field
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-496__test',
					worktreePath: '/path/to/feat/issue-496__test',
					issueType: 'issue',
					issue_numbers: ['496'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					// No oneShot field - legacy loom
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			const commandWithNoOneShot = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-496__test')

			try {
				// Execute without explicit flag (should default to 'default' behavior)
				await commandWithNoOneShot.execute()

				// Verify the user prompt is the simple workflow prompt (default mode)
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				const userPrompt = launchClaudeCall[0]
				expect(userPrompt).toBe('Guide the user through the iloom workflow!')
				expect(userPrompt).not.toContain('without awaiting confirmation')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('Answer Table Instructions - Universal Behavior', () => {
		it('should include answer table instructions in default mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__default')

			try {
				await command.execute('default')

				// Verify appendSystemPrompt contains answer table instruction text
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should include answer table instructions in noReview mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__noreview')

			try {
				await command.execute('noReview')

				// Verify appendSystemPrompt contains answer table instruction text
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should include answer table instructions in bypassPermissions mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock template manager to return content with answer table instructions
			const mockPromptContent = `Execute: @agent-iloom-issue-enhancer ISSUE_NUMBER instructing them to add their own answers to any questions they asked in the question tables they create in their GitHub comments. This documents assumptions made during execution.`
			vi.mocked(mockTemplateManager.getPrompt).mockResolvedValue(mockPromptContent)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__bypass')

			try {
				await command.execute('bypassPermissions')

				// Verify appendSystemPrompt contains answer table instruction text
				const callOptions = launchClaudeSpy.mock.calls[0][1]
				expect(callOptions.appendSystemPrompt).toContain('instructing them to add their own answers to any questions')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('Session ID for Claude Code resume support', () => {
		it('should use sessionId from loom metadata', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const workspacePath = '/path/to/feat/issue-305__session-id'
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue(workspacePath)

			try {
				await command.execute()

				// Verify launchClaude was called with sessionId from metadata
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1]).toHaveProperty('sessionId')

				// sessionId should match the mocked metadata value
				const sessionId = launchClaudeCall[1].sessionId as string
				expect(sessionId).toBe('12345678-1234-4567-8901-123456789012')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should throw error when sessionId is missing from metadata', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Get MetadataManager and reset its mock to return metadata without sessionId
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/test-branch',
					worktreePath: '/path/to/workspace',
					issueType: 'issue',
					issue_numbers: ['123'],
					databaseBranchName: null,
					parentLoomBranch: null,
					// sessionId intentionally omitted to test error handling
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}) as never)

			// Create a new command that will use the modified mock
			const commandWithNoSessionId = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager
			)

			const workspacePath = '/path/to/feat/issue-305__no-session'
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue(workspacePath)

			try {
				await expect(commandWithNoSessionId.execute()).rejects.toThrow(
					'No session ID found in loom metadata. This loom may need to be recreated with `il start`.'
				)

				// Verify launchClaude was NOT called
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use same sessionId for repeated executions in same loom', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const workspacePath = '/path/to/feat/issue-305__session-id'
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue(workspacePath)

			try {
				await command.execute()
				const sessionId1 = launchClaudeSpy.mock.calls[0][1].sessionId as string

				launchClaudeSpy.mockClear()

				await command.execute()
				const sessionId2 = launchClaudeSpy.mock.calls[0][1].sessionId as string

				// Same loom should use same sessionId (from metadata)
				expect(sessionId1).toBe(sessionId2)
				expect(sessionId1).toBe('12345678-1234-4567-8901-123456789012')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('First-time user experience', () => {
		it('should set FIRST_TIME_USER variable when isFirstRun returns true', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(true),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__firstrun')

			// Create command with mock first-run manager
			const commandWithFirstRun = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined, // agentManager
				undefined, // settingsManager
				mockFirstRunManager as never
			)

			try {
				await commandWithFirstRun.execute()

				// Verify isFirstRun was checked
				expect(mockFirstRunManager.isFirstRun).toHaveBeenCalled()

				// Verify template manager was called with FIRST_TIME_USER=true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						FIRST_TIME_USER: true,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should not set FIRST_TIME_USER when isFirstRun returns false', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(false),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__notfirstrun')

			const commandWithFirstRun = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined, // agentManager
				undefined, // settingsManager
				mockFirstRunManager as never
			)

			try {
				await commandWithFirstRun.execute()

				// Verify isFirstRun was checked
				expect(mockFirstRunManager.isFirstRun).toHaveBeenCalled()

				// Verify template manager was NOT called with FIRST_TIME_USER
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1].FIRST_TIME_USER).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should mark as run after successful launch for first-time users', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(true),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__firstrun')

			const commandWithFirstRun = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				undefined,
				mockFirstRunManager as never
			)

			try {
				await commandWithFirstRun.execute()

				// Verify markAsRun was called after successful launch
				expect(mockFirstRunManager.markAsRun).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should not mark as run for non-first-time users', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(false),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__notfirstrun')

			const commandWithFirstRun = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				undefined,
				mockFirstRunManager as never
			)

			try {
				await commandWithFirstRun.execute()

				// Verify markAsRun was NOT called
				expect(mockFirstRunManager.markAsRun).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should load README and settings schema content for first-time users', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(true),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__firstrun')

			const commandWithFirstRun = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				undefined,
				mockFirstRunManager as never
			)

			try {
				await commandWithFirstRun.execute()

				// Verify template manager was called with README_CONTENT and SETTINGS_SCHEMA_CONTENT
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1]).toHaveProperty('README_CONTENT')
				expect(templateCall[1]).toHaveProperty('SETTINGS_SCHEMA_CONTENT')
				// Content should be strings (even if empty due to file not found in test env)
				expect(typeof templateCall[1].README_CONTENT).toBe('string')
				expect(typeof templateCall[1].SETTINGS_SCHEMA_CONTENT).toBe('string')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('AUTO_COMMIT_PUSH template variable', () => {
		it('should set AUTO_COMMIT_PUSH true when draft PR mode and autoCommitPush not explicitly false', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__auto-commit',
					worktreePath: '/path/to/feat/issue-498__auto-commit',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 42, // Draft PR mode enabled
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with autoCommitPush undefined (should default to true)
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						// autoCommitPush not set - should default to true
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithDraftPr = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__auto-commit')

			try {
				await commandWithDraftPr.execute()

				// Verify template manager was called with AUTO_COMMIT_PUSH=true
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						DRAFT_PR_MODE: true,
						DRAFT_PR_NUMBER: 42,
						AUTO_COMMIT_PUSH: true,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should set AUTO_COMMIT_PUSH false when autoCommitPush explicitly false', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__no-auto-commit',
					worktreePath: '/path/to/feat/issue-498__no-auto-commit',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 43, // Draft PR mode enabled
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with autoCommitPush explicitly false
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						autoCommitPush: false, // Explicitly disabled
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithDraftPr = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__no-auto-commit')

			try {
				await commandWithDraftPr.execute()

				// Verify template manager was called with AUTO_COMMIT_PUSH=false
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						DRAFT_PR_MODE: true,
						DRAFT_PR_NUMBER: 43,
						AUTO_COMMIT_PUSH: false,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should not set AUTO_COMMIT_PUSH when not in draft PR mode', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata WITHOUT draftPrNumber
			// Use statically imported MetadataManager (mocked at top of file)
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__standard',
					worktreePath: '/path/to/feat/issue-498__standard',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					// No draftPrNumber - standard issue mode
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with autoCommitPush true (shouldn't matter since not in draft PR mode)
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'local',
						autoCommitPush: true,
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandStandard = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__standard')

			try {
				await commandStandard.execute()

				// Verify template manager was called with STANDARD_ISSUE_MODE and NO AUTO_COMMIT_PUSH
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1].STANDARD_ISSUE_MODE).toBe(true)
				expect(templateCall[1].DRAFT_PR_MODE).toBeUndefined()
				expect(templateCall[1].AUTO_COMMIT_PUSH).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('GIT_REMOTE validation', () => {
		it('should accept valid remote names with alphanumeric characters, underscores, and hyphens', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__remote-test',
					worktreePath: '/path/to/feat/issue-498__remote-test',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 42,
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with valid remote names
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						remote: 'my_remote-123',
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithValidRemote = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__remote-test')

			try {
				await commandWithValidRemote.execute()

				// Verify template manager was called with the valid remote
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						GIT_REMOTE: 'my_remote-123',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should throw error for remote names with invalid characters', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__invalid-remote',
					worktreePath: '/path/to/feat/issue-498__invalid-remote',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 42,
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with invalid remote name (contains shell injection)
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						remote: 'origin; rm -rf /',
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithInvalidRemote = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__invalid-remote')

			try {
				await expect(commandWithInvalidRemote.execute()).rejects.toThrow(
					'Invalid git remote name: "origin; rm -rf /". Remote names can only contain alphanumeric characters, underscores, and hyphens.'
				)

				// Verify launchClaude was NOT called
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should throw error for remote names with spaces', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__space-remote',
					worktreePath: '/path/to/feat/issue-498__space-remote',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 42,
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings with invalid remote name containing spaces
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						remote: 'my remote',
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithSpaceRemote = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__space-remote')

			try {
				await expect(commandWithSpaceRemote.execute()).rejects.toThrow(
					'Invalid git remote name: "my remote". Remote names can only contain alphanumeric characters, underscores, and hyphens.'
				)

				// Verify launchClaude was NOT called
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should use default origin remote when no remote is configured', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock MetadataManager to return metadata with draftPrNumber
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Test loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-498__default-remote',
					worktreePath: '/path/to/feat/issue-498__default-remote',
					issueType: 'issue',
					issue_numbers: ['498'],
					sessionId: '12345678-1234-4567-8901-123456789012',
					draftPrNumber: 42,
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
			}))

			// Mock settings without remote configured
			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					mergeBehavior: {
						mode: 'github-draft-pr',
						// remote not set - should default to 'origin'
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn((agents) => agents),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const commandWithDefaultRemote = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
			)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-498__default-remote')

			try {
				await commandWithDefaultRemote.execute()

				// Verify template manager was called with default 'origin' remote
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						GIT_REMOTE: 'origin',
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('session.started telemetry', () => {
		it('tracks session.started with has_neon and language on spin', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-50__telemetry-test')

			const commandWithSettings = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				await commandWithSettings.execute()

				const mockTrack = TelemetryService.getInstance().track
				expect(mockTrack).toHaveBeenCalledWith('session.started', {
					has_neon: false,
					language: 'typescript',
				})
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('has_neon is true when neon settings are configured', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					databaseProviders: {
						neon: { projectId: 'test-project' },
					},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-51__neon-test')

			const commandWithNeon = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				await commandWithNeon.execute()

				const mockTrack = TelemetryService.getInstance().track
				expect(mockTrack).toHaveBeenCalledWith('session.started', {
					has_neon: true,
					language: 'typescript',
				})
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('has_neon is false when neon settings are absent', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					databaseProviders: {},
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-52__no-neon')

			const commandWithoutNeon = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				await commandWithoutNeon.execute()

				const mockTrack = TelemetryService.getInstance().track
				expect(mockTrack).toHaveBeenCalledWith('session.started', {
					has_neon: false,
					language: 'typescript',
				})
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('does not throw if telemetry tracking fails', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Make detectProjectLanguage throw
			vi.mocked(languageDetector.detectProjectLanguage).mockRejectedValueOnce(new Error('detection failed'))

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-53__fail-test')

			const commandFailTelemetry = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				// Should not throw despite telemetry failure
				await expect(commandFailTelemetry.execute()).resolves.not.toThrow()
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('child epic swarm mode', () => {
		it('enters swarm mode for child looms that are also epics', async () => {
			// Regression test: a loom with parentLoom AND issueType 'epic' must still enter swarm mode
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			vi.spyOn(gitUtils, 'findMainWorktreePathWithSettings').mockResolvedValue('/test/main')
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__child-epic')

			const { SwarmSetupService } = await import('../lib/SwarmSetupService.js')
			vi.mocked(SwarmSetupService).mockImplementation(() => ({
				setupSwarm: vi.fn().mockResolvedValue({
					epicWorktreePath: '/path/to/child-epic',
					epicBranch: 'feat/issue-100__child-epic',
					childWorktrees: [
						{ issueId: '301', worktreePath: '/path/to/child-301', branch: 'feat/issue-301', success: true },
					],
					agentsRendered: [],
					workerAgentRendered: true,
				}),
			}) as unknown as SwarmSetupService)

			const readMetadataMock = vi.fn()
			const parentLoom = {
				type: 'epic' as const,
				identifier: 50,
				branchName: 'feat/issue-50__parent-epic',
				worktreePath: '/path/to/parent-epic',
			}
			// First call: initial metadata read in executeInternal (Step 2)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Child epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__child-epic',
				worktreePath: '/path/to/child-epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				parentLoom,
				childIssues: [
					{ number: '#301', title: 'Grandchild 1', body: 'Body 1' },
				],
				sessionId: 'child-epic-session-id',
			})
			// Second call: fresh metadata re-read in executeInternal (Step 2.1.1)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Child epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__child-epic',
				worktreePath: '/path/to/child-epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				parentLoom,
				childIssues: [
					{ number: '#301', title: 'Grandchild 1', body: 'Body 1' },
				],
				dependencyMap: {},
				sessionId: 'child-epic-session-id',
			})
			// Third call: child filtering reads metadata for child #301 (no existing worktree)
			readMetadataMock.mockResolvedValueOnce(null)
			// Fourth call: child metadata for telemetry
			readMetadataMock.mockResolvedValueOnce({
				state: 'done',
				created_at: '2025-01-01T00:00:00Z',
			})

			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: readMetadataMock,
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
				listFinishedMetadata: vi.fn().mockResolvedValue([]),
			}) as unknown as MetadataManager)

			const cmd = new IgniteCommand(
				mockTemplateManager,
				{
					getRepoInfo: vi.fn().mockResolvedValue({
						currentBranch: 'feat/issue-100__child-epic',
					}),
				} as unknown as GitWorktreeManager,
				{
					loadAgents: vi.fn().mockResolvedValue([]),
					formatForCli: vi.fn().mockReturnValue({}),
					renderAgentsToDisk: vi.fn().mockResolvedValue([]),
				} as never,
				{
					loadSettings: vi.fn().mockResolvedValue({
						issueTracker: { provider: 'github' },
					}),
					getSpinModel: vi.fn().mockReturnValue('opus'),
				} as never,
			)

			await cmd.execute()

			// Should have entered swarm mode — orchestrator launched via launchClaude
			expect(launchClaudeSpy).toHaveBeenCalled()

			process.cwd = originalCwd
			launchClaudeSpy.mockRestore()
		})
	})

	describe('executeSwarmMode - child state filtering', () => {
		let launchClaudeSpy: ReturnType<typeof vi.spyOn>
		let findMainWorktreePathSpy: ReturnType<typeof vi.spyOn>
		let originalCwd: typeof process.cwd
		let mockSetupSwarm: ReturnType<typeof vi.fn>

		beforeEach(async () => {
			launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			findMainWorktreePathSpy = vi.spyOn(gitUtils, 'findMainWorktreePathWithSettings').mockResolvedValue('/test/main')
			originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__epic')

			mockSetupSwarm = vi.fn().mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const { SwarmSetupService } = await import('../lib/SwarmSetupService.js')
			vi.mocked(SwarmSetupService).mockImplementation(() => ({
				setupSwarm: mockSetupSwarm,
			}) as unknown as SwarmSetupService)
		})

		afterEach(() => {
			process.cwd = originalCwd
			launchClaudeSpy.mockRestore()
			findMainWorktreePathSpy.mockRestore()
		})

		function createFilteringCommand(
			childIssues: Array<{ number: string; title: string; body: string }>,
			childFilterMetadata: Array<{ state: string; created_at: string } | null>,
			finishedMetadata: Array<{ issue_numbers: string[]; state: string }> = [],
		) {
			const readMetadataMock = vi.fn()
			// First call: initial metadata read in executeInternal (Step 2)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__epic',
				worktreePath: '/path/to/epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				childIssues,
				sessionId: 'epic-session-id',
			})
			// Second call: fresh metadata re-read in executeInternal (Step 2.1.1)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__epic',
				worktreePath: '/path/to/epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				childIssues,
				dependencyMap: {},
				sessionId: 'epic-session-id',
			})
			// Child filtering calls: readMetadata for each child worktree
			for (const meta of childFilterMetadata) {
				readMetadataMock.mockResolvedValueOnce(meta)
			}
			// Additional calls for telemetry (return null for simplicity)
			for (let i = 0; i < childIssues.length; i++) {
				readMetadataMock.mockResolvedValueOnce(null)
			}

			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: readMetadataMock,
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
				listFinishedMetadata: vi.fn().mockResolvedValue(finishedMetadata),
			}) as unknown as MetadataManager)

			return new IgniteCommand(
				mockTemplateManager,
				{
					getRepoInfo: vi.fn().mockResolvedValue({
						currentBranch: 'feat/issue-100__epic',
					}),
				} as unknown as GitWorktreeManager,
				{
					loadAgents: vi.fn().mockResolvedValue([]),
					formatForCli: vi.fn().mockReturnValue({}),
					renderAgentsToDisk: vi.fn().mockResolvedValue([]),
				} as never,
				{
					loadSettings: vi.fn().mockResolvedValue({
						issueTracker: { provider: 'github' },
					}),
					getSpinModel: vi.fn().mockReturnValue('opus'),
				} as never,
			)
		}

		it('should skip children in "done" state and only pass pending children to setupSwarm', async () => {
			const childIssues = [
				{ number: '#201', title: 'Child 1', body: 'Body 1' },
				{ number: '#202', title: 'Child 2', body: 'Body 2' },
				{ number: '#203', title: 'Child 3', body: 'Body 3' },
			]
			// Child #201 is done, #202 and #203 have no metadata (pending)
			const childFilterMetadata: Array<{ state: string; created_at: string } | null> = [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
				null,
				null,
			]

			// Update setupSwarm to return results matching the pending children
			mockSetupSwarm.mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [
					{ issueId: '202', worktreePath: '/path/to/child-202', branch: 'feat/issue-202', success: true },
					{ issueId: '203', worktreePath: '/path/to/child-203', branch: 'feat/issue-203', success: true },
				],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const cmd = createFilteringCommand(childIssues, childFilterMetadata)
			await cmd.execute()

			// setupSwarm should have been called with only 2 pending children (not 3)
			expect(mockSetupSwarm).toHaveBeenCalledWith(
				'100',
				expect.any(String),
				expect.any(String),
				expect.arrayContaining([
					expect.objectContaining({ number: '#202' }),
					expect.objectContaining({ number: '#203' }),
				]),
				expect.any(String),
				expect.any(String),
				expect.any(Object),
			)
			// Verify the done child was NOT passed
			const passedChildren = mockSetupSwarm.mock.calls[0][3]
			expect(passedChildren).toHaveLength(2)
			expect(passedChildren.find((c: { number: string }) => c.number === '#201')).toBeUndefined()
		})

		it('should NOT skip children in "failed" state (failed children should be recreated)', async () => {
			const childIssues = [
				{ number: '#201', title: 'Child 1', body: 'Body 1' },
				{ number: '#202', title: 'Child 2', body: 'Body 2' },
			]
			// Child #201 is failed, #202 has no metadata (pending) - both should be passed through
			const childFilterMetadata: Array<{ state: string; created_at: string } | null> = [
				{ state: 'failed', created_at: '2025-01-01T00:00:00Z' },
				null,
			]

			mockSetupSwarm.mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [
					{ issueId: '201', worktreePath: '/path/to/child-201', branch: 'feat/issue-201', success: true },
					{ issueId: '202', worktreePath: '/path/to/child-202', branch: 'feat/issue-202', success: true },
				],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const cmd = createFilteringCommand(childIssues, childFilterMetadata)
			await cmd.execute()

			// Both children should be passed to setupSwarm (failed is NOT skipped)
			const passedChildren = mockSetupSwarm.mock.calls[0][3]
			expect(passedChildren).toHaveLength(2)
			expect(passedChildren[0]).toEqual(expect.objectContaining({ number: '#201' }))
			expect(passedChildren[1]).toEqual(expect.objectContaining({ number: '#202' }))
		})

		it('should still launch orchestrator when all children are done (idempotent re-spin)', async () => {
			const childIssues = [
				{ number: '#201', title: 'Child 1', body: 'Body 1' },
				{ number: '#202', title: 'Child 2', body: 'Body 2' },
			]
			// Both children are done
			const childFilterMetadata: Array<{ state: string; created_at: string } | null> = [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
			]

			mockSetupSwarm.mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const cmd = createFilteringCommand(childIssues, childFilterMetadata)
			await cmd.execute()

			// setupSwarm should be called with empty pending list — orchestrator handles finalization
			expect(mockSetupSwarm).toHaveBeenCalled()
			const passedChildren = mockSetupSwarm.mock.calls[0][3]
			expect(passedChildren).toHaveLength(0)
		})

		it('should treat children without existing metadata as pending', async () => {
			const childIssues = [
				{ number: '#201', title: 'Child 1', body: 'Body 1' },
				{ number: '#202', title: 'Child 2', body: 'Body 2' },
			]
			// Both children have no existing metadata (readMetadata returns null)
			const childFilterMetadata: Array<{ state: string; created_at: string } | null> = [
				null,
				null,
			]

			mockSetupSwarm.mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [
					{ issueId: '201', worktreePath: '/path/to/child-201', branch: 'feat/issue-201', success: true },
					{ issueId: '202', worktreePath: '/path/to/child-202', branch: 'feat/issue-202', success: true },
				],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const cmd = createFilteringCommand(childIssues, childFilterMetadata)
			await cmd.execute()

			// setupSwarm should be called with both children
			const passedChildren = mockSetupSwarm.mock.calls[0][3]
			expect(passedChildren).toHaveLength(2)
		})

		it('should find done state from finished metadata when active worktree metadata is null', async () => {
			const childIssues = [
				{ number: '#201', title: 'Child 1', body: 'Body 1' },
				{ number: '#202', title: 'Child 2', body: 'Body 2' },
			]
			// Both children have no active worktree metadata (readMetadata returns null)
			const childFilterMetadata: Array<{ state: string; created_at: string } | null> = [
				null,
				null,
			]
			// But child #201 has finished metadata with state 'done'
			const finishedMeta = [
				{ issue_numbers: ['201'], state: 'done' },
			]

			mockSetupSwarm.mockResolvedValue({
				epicWorktreePath: '/path/to/epic',
				epicBranch: 'feat/issue-100__epic',
				childWorktrees: [
					{ issueId: '202', worktreePath: '/path/to/child-202', branch: 'feat/issue-202', success: true },
				],
				agentsRendered: [],
				workerAgentRendered: true,
			})

			const cmd = createFilteringCommand(childIssues, childFilterMetadata, finishedMeta)
			await cmd.execute()

			// Only child #202 should be passed (child #201 is done via finished metadata)
			const passedChildren = mockSetupSwarm.mock.calls[0][3]
			expect(passedChildren).toHaveLength(1)
			expect(passedChildren[0]).toEqual(expect.objectContaining({ number: '#202' }))
		})
	})

	describe('swarm telemetry', () => {
		// Helper to create an IgniteCommand that enters swarm mode
		function createSwarmCommand(
			templateMgr: PromptTemplateManager,
			childMetadataStates: Array<{ state: string; created_at: string }>,
		) {
			const readMetadataMock = vi.fn()
			// First call: initial metadata read in executeInternal (Step 2)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__epic',
				worktreePath: '/path/to/epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				childIssues: [
					{ number: '#201', title: 'Child 1', body: 'Body 1' },
					{ number: '#202', title: 'Child 2', body: 'Body 2' },
				],
				sessionId: 'epic-session-id',
			})
			// Second call: fresh metadata re-read in executeInternal (Step 2.1.1)
			readMetadataMock.mockResolvedValueOnce({
				description: 'Epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-100__epic',
				worktreePath: '/path/to/epic',
				issueType: 'epic',
				issue_numbers: ['100'],
				childIssues: [
					{ number: '#201', title: 'Child 1', body: 'Body 1' },
					{ number: '#202', title: 'Child 2', body: 'Body 2' },
				],
				dependencyMap: {},
				sessionId: 'epic-session-id',
			})
			// Child filtering calls: readMetadata for each child worktree (no existing metadata)
			for (let i = 0; i < 2; i++) {
				readMetadataMock.mockResolvedValueOnce(null)
			}
			// Subsequent calls: child metadata reads for telemetry
			for (const childMeta of childMetadataStates) {
				readMetadataMock.mockResolvedValueOnce({
					state: childMeta.state,
					created_at: childMeta.created_at,
				})
			}

			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: readMetadataMock,
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
				listFinishedMetadata: vi.fn().mockResolvedValue([]),
			}) as unknown as MetadataManager)

			const mockGitWorktreeManagerSwarm = {
				getRepoInfo: vi.fn().mockResolvedValue({
					currentBranch: 'feat/issue-100__epic',
				}),
			} as unknown as GitWorktreeManager

			const mockSettingsManagerSwarm = {
				loadSettings: vi.fn().mockResolvedValue({
					issueTracker: { provider: 'github' },
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue([]),
				formatForCli: vi.fn().mockReturnValue({}),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			return new IgniteCommand(
				templateMgr,
				mockGitWorktreeManagerSwarm,
				mockAgentManager as never,
				mockSettingsManagerSwarm as never,
			)
		}

		let launchClaudeSpy: ReturnType<typeof vi.spyOn>
		let findMainWorktreePathSpy: ReturnType<typeof vi.spyOn>
		let originalCwd: typeof process.cwd

		beforeEach(async () => {
			launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			findMainWorktreePathSpy = vi.spyOn(gitUtils, 'findMainWorktreePathWithSettings').mockResolvedValue('/test/main')
			originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__epic')

			// Mock SwarmSetupService.setupSwarm
			const { SwarmSetupService } = await import('../lib/SwarmSetupService.js')
			vi.mocked(SwarmSetupService).mockImplementation(() => ({
				setupSwarm: vi.fn().mockResolvedValue({
					epicWorktreePath: '/path/to/epic',
					epicBranch: 'feat/issue-100__epic',
					childWorktrees: [
						{ issueId: '201', worktreePath: '/path/to/child-201', branch: 'feat/issue-201', success: true },
						{ issueId: '202', worktreePath: '/path/to/child-202', branch: 'feat/issue-202', success: true },
					],
					agentsRendered: [],
					workerAgentRendered: true,
				}),
			}) as unknown as SwarmSetupService)
		})

		afterEach(() => {
			process.cwd = originalCwd
			launchClaudeSpy.mockRestore()
			findMainWorktreePathSpy.mockRestore()
		})

		it('tracks swarm.started with child_count and tracker before launching orchestrator', async () => {
			const swarmCommand = createSwarmCommand(mockTemplateManager, [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
			])

			await swarmCommand.execute()

			const mockTrack = TelemetryService.getInstance().track
			expect(mockTrack).toHaveBeenCalledWith('swarm.started', {
				child_count: 2,
				tracker: 'github',
			})
		})

		it('tracks swarm.completed with total_children, succeeded, failed, duration_minutes', async () => {
			const swarmCommand = createSwarmCommand(mockTemplateManager, [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
				{ state: 'failed', created_at: '2025-01-01T00:00:00Z' },
			])

			await swarmCommand.execute()

			const mockTrack = TelemetryService.getInstance().track
			expect(mockTrack).toHaveBeenCalledWith('swarm.completed', expect.objectContaining({
				total_children: 2,
				succeeded: 1,
				failed: 1,
			}))
			// duration_minutes should be a number
			const completedCall = vi.mocked(mockTrack).mock.calls.find(
				(call) => call[0] === 'swarm.completed'
			)
			expect(completedCall).toBeDefined()
			expect(typeof completedCall![1].duration_minutes).toBe('number')
		})

		it('tracks swarm.child_completed for each child with success and duration_minutes', async () => {
			const swarmCommand = createSwarmCommand(mockTemplateManager, [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
				{ state: 'failed', created_at: '2025-01-01T00:00:00Z' },
			])

			await swarmCommand.execute()

			const mockTrack = TelemetryService.getInstance().track
			const childCompletedCalls = vi.mocked(mockTrack).mock.calls.filter(
				(call) => call[0] === 'swarm.child_completed'
			)
			expect(childCompletedCalls).toHaveLength(2)

			// First child: done
			expect(childCompletedCalls[0][1]).toEqual(expect.objectContaining({
				success: true,
			}))
			expect(typeof childCompletedCalls[0][1].duration_minutes).toBe('number')

			// Second child: failed
			expect(childCompletedCalls[1][1]).toEqual(expect.objectContaining({
				success: false,
			}))
			expect(typeof childCompletedCalls[1][1].duration_minutes).toBe('number')
		})

		it('handles telemetry failures gracefully', async () => {
			// Make track throw for swarm events
			const mockTrack = TelemetryService.getInstance().track as ReturnType<typeof vi.fn>
			mockTrack.mockImplementation((event: string) => {
				if (event === 'swarm.started') throw new Error('telemetry failed')
			})

			const swarmCommand = createSwarmCommand(mockTemplateManager, [
				{ state: 'done', created_at: '2025-01-01T00:00:00Z' },
			])

			// Should not throw despite telemetry failure
			await expect(swarmCommand.execute()).resolves.not.toThrow()
			expect(launchClaudeSpy).toHaveBeenCalled()
		})
	})

	describe('Main worktree validation', () => {
		it('should throw WorktreeValidationError when running from main worktree', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const isValidGitRepoSpy = vi.spyOn(gitUtils, 'isValidGitRepo').mockResolvedValue(true)
			const getWorktreeRootSpy = vi.spyOn(gitUtils, 'getWorktreeRoot').mockResolvedValue('/path/to/main')

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockGitWorktreeManagerWithMain = {
				getRepoInfo: vi.fn().mockResolvedValue({
					currentBranch: 'main',
				}),
				listWorktrees: vi.fn().mockResolvedValue([
					{ path: '/path/to/main', branch: 'main' },
					{ path: '/path/to/feat/issue-123', branch: 'feat/issue-123' },
				]),
				isMainWorktree: vi.fn().mockResolvedValue(true), // This is the main worktree
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			const commandWithMainWorktree = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManagerWithMain as unknown as GitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				await expect(commandWithMainWorktree.execute()).rejects.toThrow(WorktreeValidationError)
				await expect(commandWithMainWorktree.execute()).rejects.toThrow(
					'You cannot run the command from the main worktree.'
				)

				// Verify launchClaude was NOT called
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				isValidGitRepoSpy.mockRestore()
				getWorktreeRootSpy.mockRestore()
			}
		})

		it('should not throw when running from a feature worktree', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const isValidGitRepoSpy = vi.spyOn(gitUtils, 'isValidGitRepo').mockResolvedValue(true)
			const getWorktreeRootSpy = vi.spyOn(gitUtils, 'getWorktreeRoot').mockResolvedValue('/path/to/feat/issue-123')

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockGitWorktreeManagerWithFeature = {
				getRepoInfo: vi.fn().mockResolvedValue({
					currentBranch: 'feat/issue-123__test',
				}),
				listWorktrees: vi.fn().mockResolvedValue([
					{ path: '/path/to/main', branch: 'main' },
					{ path: '/path/to/feat/issue-123', branch: 'feat/issue-123__test' },
				]),
				isMainWorktree: vi.fn().mockResolvedValue(false), // This is NOT the main worktree
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123')

			const commandWithFeatureWorktree = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManagerWithFeature as unknown as GitWorktreeManager,
				undefined,
				mockSettingsManager as never,
			)

			try {
				// Should not throw - execution should proceed normally
				await commandWithFeatureWorktree.execute()

				// Verify launchClaude WAS called
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				isValidGitRepoSpy.mockRestore()
				getWorktreeRootSpy.mockRestore()
			}
		})

		it('should allow execution when not in a git repository', async () => {
			// When not in a git repo, the validation should allow execution to continue
			// (detectWorkspaceContext will handle the regular workflow gracefully)
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const isValidGitRepoSpy = vi.spyOn(gitUtils, 'isValidGitRepo').mockResolvedValue(false) // Not a git repo

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/non-git-dir')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockRejectedValue(new Error('Not a git repository'))

			try {
				// Should not throw for non-git repo - let detectWorkspaceContext handle it
				await command.execute()

				// Verify launchClaude was called (regular workflow)
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				isValidGitRepoSpy.mockRestore()
			}
		})

		it('should allow execution when directory is not a registered worktree', async () => {
			// When the directory is a git repo but not a registered worktree,
			// the validation should allow execution (regular workflow)
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const isValidGitRepoSpy = vi.spyOn(gitUtils, 'isValidGitRepo').mockResolvedValue(true)
			const getWorktreeRootSpy = vi.spyOn(gitUtils, 'getWorktreeRoot').mockResolvedValue('/path/to/unregistered')

			const mockGitWorktreeManagerUnregistered = {
				getRepoInfo: vi.fn().mockResolvedValue({
					currentBranch: 'some-branch',
				}),
				listWorktrees: vi.fn().mockResolvedValue([
					{ path: '/path/to/main', branch: 'main' },
				]),
				isMainWorktree: vi.fn(),
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/unregistered')

			const commandUnregistered = new IgniteCommand(
				mockTemplateManager,
				mockGitWorktreeManagerUnregistered as unknown as GitWorktreeManager,
			)

			try {
				// Should not throw - not a registered worktree, so skip main check
				await commandUnregistered.execute()

				// isMainWorktree should NOT have been called since we're not a registered worktree
				expect(mockGitWorktreeManagerUnregistered.isMainWorktree).not.toHaveBeenCalled()

				// Verify launchClaude was called
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				isValidGitRepoSpy.mockRestore()
				getWorktreeRootSpy.mockRestore()
			}
		})
	})

	describe('Epic child worktree spin prevention', () => {
		it('should throw WorktreeValidationError when running il spin in a child worktree of an epic loom', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-200__child-issue')

			// Mock MetadataManager to return child-of-epic metadata
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Child issue of epic',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-200__child-issue',
					worktreePath: '/path/to/feat/issue-200__child-issue',
					issueType: 'issue',
					issue_numbers: ['200'],
					parentLoom: {
						type: 'epic' as const,
						identifier: 100,
						branchName: 'feat/issue-100__epic',
						worktreePath: '/path/to/epic',
					},
					sessionId: '12345678-1234-4567-8901-123456789012',
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
			}) as unknown as MetadataManager)

			try {
				const error = await command.execute().catch((e: Error) => e)
				expect(error).toBeInstanceOf(WorktreeValidationError)
				expect((error as Error).message).toContain('Cannot run il spin in a child worktree of an epic loom')

				// Verify launchClaude was NOT called
				expect(launchClaudeSpy).not.toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should allow il spin in regular child looms (child of non-epic parent)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-300__child-of-regular')

			// Mock MetadataManager to return child-of-regular-loom metadata
			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: vi.fn().mockResolvedValue({
					description: 'Child of regular loom',
					created_at: '2025-01-01T00:00:00Z',
					branchName: 'feat/issue-300__child-of-regular',
					worktreePath: '/path/to/feat/issue-300__child-of-regular',
					issueType: 'issue',
					issue_numbers: ['300'],
					parentLoom: {
						type: 'issue' as const,
						identifier: 250,
						branchName: 'feat/issue-250__parent',
						worktreePath: '/path/to/parent',
					},
					sessionId: '12345678-1234-4567-8901-123456789012',
				}),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
			}) as unknown as MetadataManager)

			try {
				await command.execute()

				// Verify launchClaude WAS called - regular child looms should work
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should allow il spin in child epics (child of epic that is itself an epic)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			vi.spyOn(gitUtils, 'findMainWorktreePathWithSettings').mockResolvedValue('/test/main')

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-400__child-epic')

			const { SwarmSetupService } = await import('../lib/SwarmSetupService.js')
			vi.mocked(SwarmSetupService).mockImplementation(() => ({
				setupSwarm: vi.fn().mockResolvedValue({
					epicWorktreePath: '/path/to/child-epic',
					epicBranch: 'feat/issue-400__child-epic',
					childWorktrees: [
						{ issueId: '501', worktreePath: '/path/to/child-501', branch: 'feat/issue-501', success: true },
					],
					agentsRendered: [],
					workerAgentRendered: true,
				}),
			}) as unknown as SwarmSetupService)

			const parentLoom = {
				type: 'epic' as const,
				identifier: 100,
				branchName: 'feat/issue-100__parent-epic',
				worktreePath: '/path/to/parent-epic',
			}

			const readMetadataMock = vi.fn()
			// First call: initial metadata read
			readMetadataMock.mockResolvedValueOnce({
				description: 'Child epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-400__child-epic',
				worktreePath: '/path/to/child-epic',
				issueType: 'epic',
				issue_numbers: ['400'],
				parentLoom,
				childIssues: [
					{ number: '#501', title: 'Grandchild 1', body: 'Body 1' },
				],
				sessionId: 'child-epic-session-id',
			})
			// Second call: fresh metadata re-read for swarm mode
			readMetadataMock.mockResolvedValueOnce({
				description: 'Child epic loom',
				created_at: '2025-01-01T00:00:00Z',
				branchName: 'feat/issue-400__child-epic',
				worktreePath: '/path/to/child-epic',
				issueType: 'epic',
				issue_numbers: ['400'],
				parentLoom,
				childIssues: [
					{ number: '#501', title: 'Grandchild 1', body: 'Body 1' },
				],
				dependencyMap: {},
				sessionId: 'child-epic-session-id',
			})
			// Third call: child filtering reads metadata for child #501 (no existing worktree)
			readMetadataMock.mockResolvedValueOnce(null)
			// Fourth call: child metadata for telemetry
			readMetadataMock.mockResolvedValueOnce({
				state: 'done',
				created_at: '2025-01-01T00:00:00Z',
			})

			vi.mocked(MetadataManager).mockImplementationOnce(() => ({
				readMetadata: readMetadataMock,
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
				listFinishedMetadata: vi.fn().mockResolvedValue([]),
			}) as unknown as MetadataManager)

			const cmd = new IgniteCommand(
				mockTemplateManager,
				{
					getRepoInfo: vi.fn().mockResolvedValue({
						currentBranch: 'feat/issue-400__child-epic',
					}),
				} as unknown as GitWorktreeManager,
				{
					loadAgents: vi.fn().mockResolvedValue([]),
					formatForCli: vi.fn().mockReturnValue({}),
					renderAgentsToDisk: vi.fn().mockResolvedValue([]),
				} as never,
				{
					loadSettings: vi.fn().mockResolvedValue({
						issueTracker: { provider: 'github' },
					}),
					getSpinModel: vi.fn().mockReturnValue('opus'),
				} as never,
			)

			try {
				// Should NOT throw - child epics need il spin for their own swarm
				await cmd.execute()

				// Verify launchClaude WAS called (swarm mode)
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})

		it('should allow il spin in looms without a parent (top-level looms)', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-500__standalone')

			// Default mock metadata has no parentLoom, so this tests the happy path
			// The default MetadataManager mock returns parentLoomBranch: null (no parentLoom)

			try {
				await command.execute()

				// Verify launchClaude WAS called - top-level looms should work
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
			}
		})
	})

	describe('--skip-cleanup flag threading', () => {
		// Epic metadata that triggers swarm mode: has issue_numbers, no parentLoom, and childIssues
		const epicMetadata = {
			description: 'Epic loom',
			created_at: '2025-01-01T00:00:00Z',
			branchName: 'feat/issue-100__epic',
			worktreePath: '/path/to/feat/issue-100__epic',
			issueType: 'epic' as const,
			issue_numbers: ['100'],
			pr_numbers: [],
			childIssueNumbers: ['101', '102'],
			parentLoom: null,
			parentLoomBranch: null,
			databaseBranchName: null,
			sessionId: '12345678-1234-4567-8901-123456789012',
			childIssues: [
				{ number: '101', title: 'Child 1', body: 'Body 1', url: 'https://github.com/test/repo/issues/101' },
				{ number: '102', title: 'Child 2', body: 'Body 2', url: 'https://github.com/test/repo/issues/102' },
			],
			dependencyMap: {},
			capabilities: [],
			state: null,
			issueKey: null,
			issueTracker: null,
			colorHex: null,
			projectPath: null,
			issueUrls: {},
			prUrls: {},
			draftPrNumber: null,
			oneShot: null,
			mcpConfigPath: null,
			status: 'active' as const,
			finishedAt: null,
		}

		function setupSwarmModeMocks() {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)
			const findMainWorktreeSpy = vi.spyOn(gitUtils, 'findMainWorktreePathWithSettings').mockResolvedValue('/path/to/main')

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-100__epic')

			// Override MetadataManager mock to return epic metadata
			vi.mocked(MetadataManager).mockImplementation(() => ({
				readMetadata: vi.fn().mockResolvedValue(epicMetadata),
				getMetadataFilePath: vi.fn().mockReturnValue('/path/to/epic-metadata.json'),
				updateMetadata: vi.fn().mockResolvedValue(undefined),
				listFinishedMetadata: vi.fn().mockResolvedValue([]),
			}) as unknown as MetadataManager)

			const localMockTemplateManager = {
				getPrompt: vi.fn().mockResolvedValue('mocked orchestrator prompt'),
			} as unknown as PromptTemplateManager

			const localMockGitWorktreeManager = {
				getRepoInfo: vi.fn().mockResolvedValue({
					currentBranch: 'feat/issue-100__epic',
				}),
			} as unknown as GitWorktreeManager

			const mockSettingsManager = {
				loadSettings: vi.fn().mockResolvedValue({
					issueManagement: { provider: 'github' },
				}),
				getSpinModel: vi.fn().mockReturnValue('opus'),
			}

			const mockAgentManager = {
				loadAgents: vi.fn().mockResolvedValue({}),
				formatForCli: vi.fn().mockReturnValue({}),
				renderAgentsToDisk: vi.fn().mockResolvedValue([]),
			}

			const mockFirstRunManager = {
				isFirstRun: vi.fn().mockResolvedValue(false),
				markAsRun: vi.fn().mockResolvedValue(undefined),
			}

			const mockHookManager = {
				installHooks: vi.fn().mockResolvedValue(undefined),
			}

			const commandForSwarm = new IgniteCommand(
				localMockTemplateManager,
				localMockGitWorktreeManager,
				mockAgentManager as never,
				mockSettingsManager as never,
				mockFirstRunManager as never,
				mockHookManager as never,
			)

			return {
				commandForSwarm,
				localMockTemplateManager,
				launchClaudeSpy,
				findMainWorktreeSpy,
				originalCwd,
			}
		}

		it('should pass NO_CLEANUP=true to template variables when skipCleanup is true', async () => {
			const { commandForSwarm, localMockTemplateManager, launchClaudeSpy, findMainWorktreeSpy, originalCwd } = setupSwarmModeMocks()

			try {
				await commandForSwarm.execute('default', undefined, true)

				// Verify templateManager.getPrompt was called with 'swarm-orchestrator' and NO_CLEANUP: true
				expect(localMockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'swarm-orchestrator',
					expect.objectContaining({
						NO_CLEANUP: true,
						EPIC_ISSUE_NUMBER: '100',
					}),
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				findMainWorktreeSpy.mockRestore()
			}
		})

		it('should not include NO_CLEANUP in template variables when skipCleanup is false', async () => {
			const { commandForSwarm, localMockTemplateManager, launchClaudeSpy, findMainWorktreeSpy, originalCwd } = setupSwarmModeMocks()

			try {
				await commandForSwarm.execute('default', undefined, false)

				// Verify templateManager.getPrompt was called with 'swarm-orchestrator'
				expect(localMockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'swarm-orchestrator',
					expect.any(Object),
				)

				// Verify NO_CLEANUP is not present in the variables
				const templateCall = vi.mocked(localMockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1]).not.toHaveProperty('NO_CLEANUP')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				findMainWorktreeSpy.mockRestore()
			}
		})

		it('should not include NO_CLEANUP in template variables when skipCleanup is undefined', async () => {
			const { commandForSwarm, localMockTemplateManager, launchClaudeSpy, findMainWorktreeSpy, originalCwd } = setupSwarmModeMocks()

			try {
				await commandForSwarm.execute('default', undefined, undefined)

				// Verify templateManager.getPrompt was called with 'swarm-orchestrator'
				expect(localMockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'swarm-orchestrator',
					expect.any(Object),
				)

				// Verify NO_CLEANUP is not present in the variables
				const templateCall = vi.mocked(localMockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[1]).not.toHaveProperty('NO_CLEANUP')
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				findMainWorktreeSpy.mockRestore()
			}
		})

		it('should accept skipCleanup parameter in execute()', async () => {
			const { commandForSwarm, launchClaudeSpy, findMainWorktreeSpy, originalCwd } = setupSwarmModeMocks()

			try {
				// Verify execute() accepts skipCleanup without throwing a type error
				await commandForSwarm.execute('default', undefined, true)
				expect(launchClaudeSpy).toHaveBeenCalled()

				// Also verify with false
				launchClaudeSpy.mockClear()
				await commandForSwarm.execute('default', undefined, false)
				expect(launchClaudeSpy).toHaveBeenCalled()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				findMainWorktreeSpy.mockRestore()
			}
		})
	})
})

describe('Swarm orchestrator template content', () => {
	it('should include dependency install step in merge subagent prompt', async () => {
		// Dynamic import needed because PromptTemplateManager is mocked at module level for the rest of this file
		const { PromptTemplateManager: RealPromptTemplateManager } = await import('../lib/PromptTemplateManager.js')
		const currentDir = path.dirname(fileURLToPath(import.meta.url))
		const templateManager = new RealPromptTemplateManager(
			path.resolve(currentDir, '../../templates/prompts')
		)
		const rendered = await templateManager.getPrompt('swarm-orchestrator', {
			EPIC_ISSUE_NUMBER: '999',
			EPIC_WORKTREE_PATH: '/tmp/test-epic',
			EPIC_METADATA_PATH: '/tmp/test-epic/.iloom/metadata.json',
			CHILD_ISSUES: '[]',
			DEPENDENCY_MAP: '{}',
			ISSUE_PREFIX: '#',
		})

		// Verify install step uses il install-deps command
		expect(rendered).toContain('il install-deps')
		// Verify install failure is warning-only (does not fail merge)
		expect(rendered).toContain('do NOT treat the merge as failed')
		// Verify separate merge/install status reporting
		expect(rendered).toContain('Merge outcome')
		expect(rendered).toContain('Install outcome')
	})
})
