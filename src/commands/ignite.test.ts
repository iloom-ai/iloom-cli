import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IgniteCommand } from './ignite.js'
import type { PromptTemplateManager } from '../lib/PromptTemplateManager.js'
import type { GitWorktreeManager } from '../lib/GitWorktreeManager.js'
import * as claudeUtils from '../utils/claude.js'
import * as githubUtils from '../utils/github.js'

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
						model: 'claude-sonnet-4-20250514',
						permissionMode: 'acceptEdits',
					})
				)

				// Verify template manager was called with correct type and variables
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						WORKSPACE_PATH: '/path/to/feat/issue-70__description',
						ISSUE_NUMBER: 70,
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
						model: 'claude-sonnet-4-20250514',
						permissionMode: 'acceptEdits',
					})
				)

				// Verify template manager was called
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						ISSUE_NUMBER: 45,
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

		it('should read PORT from environment variables', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Mock environment variable
			const originalEnv = process.env.PORT
			process.env.PORT = '3070'

			// Mock process.cwd()
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-99__port-test')

			try {
				await command.execute()

				// Verify template manager was called with PORT
				expect(mockTemplateManager.getPrompt).toHaveBeenCalledWith(
					'issue',
					expect.objectContaining({
						PORT: 3070,
					})
				)
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				if (originalEnv !== undefined) {
					process.env.PORT = originalEnv
				} else {
					delete process.env.PORT
				}
			}
		})

		it('should handle missing PORT environment variable gracefully', async () => {
			// Spy on launchClaude
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			// Ensure PORT is not set
			const originalEnv = process.env.PORT
			delete process.env.PORT

			// Mock process.cwd()
			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/feat/issue-88__no-port')

			try {
				await command.execute()

				// Verify template manager was called without PORT
				const templateCall = vi.mocked(mockTemplateManager.getPrompt).mock.calls[0]
				expect(templateCall[0]).toBe('issue')
				expect(templateCall[1].PORT).toBeUndefined()
			} finally {
				process.cwd = originalCwd
				launchClaudeSpy.mockRestore()
				if (originalEnv !== undefined) {
					process.env.PORT = originalEnv
				}
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
						model: 'claude-sonnet-4-20250514',
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
						model: 'claude-sonnet-4-20250514', // issue workflow model
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
						ISSUE_NUMBER: 10,
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
						ISSUE_NUMBER: 100,
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
						model: 'claude-sonnet-4-20250514',
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

		it('should NOT generate MCP config for regular workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			try {
				await command.execute()

				// Verify launchClaude was NOT called with mcpConfig
				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].mcpConfig).toBeUndefined()
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
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
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
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
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

		it('should NOT pass tool filtering for regular workflows', async () => {
			const launchClaudeSpy = vi.spyOn(claudeUtils, 'launchClaude').mockResolvedValue(undefined)

			const originalCwd = process.cwd
			process.cwd = vi.fn().mockReturnValue('/path/to/main')

			mockGitWorktreeManager.getRepoInfo = vi.fn().mockResolvedValue({
				currentBranch: 'main',
			})

			try {
				await command.execute()

				const launchClaudeCall = launchClaudeSpy.mock.calls[0]
				expect(launchClaudeCall[1].allowedTools).toBeUndefined()
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
				expect(launchClaudeCall[1].allowedTools).toEqual([
					'mcp__issue_management__get_issue',
					'mcp__issue_management__get_comment',
					'mcp__issue_management__create_comment',
					'mcp__issue_management__update_comment',
				])
				expect(launchClaudeCall[1].disallowedTools).toEqual(['Bash(gh api:*), Bash(gh issue view:*), Bash(gh pr view:*), Bash(gh issue comment:*)'])
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

				// Verify settings were passed to loadAgents
				expect(mockAgentManager.loadAgents).toHaveBeenCalledWith(mockSettings)
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
				expect(mockAgentManager.loadAgents).toHaveBeenCalledWith({})
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
})
