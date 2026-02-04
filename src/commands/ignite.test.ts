import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IgniteCommand, WorktreeValidationError } from './ignite.js'
import type { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import * as claudeUtils from '../utils/claude.js'
import * as githubUtils from '../utils/github.js'
import * as gitUtils from '../utils/git.js'
import { MetadataManager } from '../lib/MetadataManager.js'

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
	})),
}))

describe('IgniteCommand', () => {
	let command: IgniteCommand
	let mockTemplateManager: PromptTemplateManager
	let mockGitWorktreeManager: GitWorktreeManager

	beforeEach(() => {
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
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
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
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)'])
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
				// For PR workflows, get_pr and set_goal are included (user's purpose unclear)
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
					'mcp__issue_management__create_issue',
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
					'mcp__issue_management__get_pr',
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
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)'])
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
					'mcp__recap__add_entry',
					'mcp__recap__get_recap',
					'mcp__recap__add_artifact',
					'mcp__recap__set_complexity',
				])
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)'])
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should include mcp__issue_management__get_pr in allowedTools for PR workflows', async () => {
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
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				getRepoInfoSpy.mockRestore()
			}
		})

		it('should NOT include mcp__issue_management__get_pr in allowedTools for issue workflows', async () => {
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
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__test')

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
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-123__pr-456')

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
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/some-other-branch')

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
			}

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-99__combined')

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
})
