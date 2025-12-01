import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa, type ExecaReturnValue } from 'execa'
import { existsSync } from 'node:fs'
import { detectClaudeCli, getClaudeVersion, launchClaude, generateBranchName, launchClaudeInNewTerminalWindow } from './claude.js'
import { logger } from './logger.js'

vi.mock('execa')
vi.mock('node:fs')
vi.mock('./logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		isDebugEnabled: vi.fn().mockReturnValue(false),
	},
}))

type MockExecaReturn = Partial<ExecaReturnValue<string>>

describe('claude utils', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('detectClaudeCli', () => {
		it('should return true when Claude CLI is found', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await detectClaudeCli()

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith('command', ['-v', 'claude'], {
				shell: true,
				timeout: 5000,
			})
		})

		it('should return false when Claude CLI is not found', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				exitCode: 1,
				stderr: 'command not found',
			})

			const result = await detectClaudeCli()

			expect(result).toBe(false)
		})

		it('should return false when command times out', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				message: 'Timeout',
			})

			const result = await detectClaudeCli()

			expect(result).toBe(false)
		})
	})

	describe('getClaudeVersion', () => {
		it('should return version when Claude CLI is available', async () => {
			const version = '1.2.3'
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: version,
				exitCode: 0,
			} as MockExecaReturn)

			const result = await getClaudeVersion()

			expect(result).toBe(version)
			expect(execa).toHaveBeenCalledWith('claude', ['--version'], {
				timeout: 5000,
			})
		})

		it('should return null when Claude CLI is not available', async () => {
			vi.mocked(execa).mockRejectedValueOnce({
				exitCode: 1,
				stderr: 'command not found',
			})

			const result = await getClaudeVersion()

			expect(result).toBeNull()
		})

		it('should trim whitespace from version string', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '  1.2.3\n',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await getClaudeVersion()

			expect(result).toBe('1.2.3')
		})
	})

	describe('launchClaude', () => {
		describe('headless mode', () => {
			it('should launch in headless mode and return output', async () => {
				const prompt = 'Generate a branch name'
				const output = 'feat/issue-123-new-feature'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: output,
					exitCode: 0,
				} as MockExecaReturn)

				const result = await launchClaude(prompt, { headless: true })

				expect(result).toBe(output)
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0, // Disabled timeout
					})
				)
			})

			it('should include model flag when model is specified', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should include permission mode when specified', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					permissionMode: 'plan',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should not include permission mode when set to default', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					permissionMode: 'default',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should include add-dir flag when specified', async () => {
				const prompt = 'Test prompt'
				const workspacePath = '/path/to/workspace'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					addDir: workspacePath,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', workspacePath, '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should set cwd to addDir in headless mode when addDir is specified', async () => {
				const prompt = 'Test prompt'
				const workspacePath = '/path/to/workspace'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					addDir: workspacePath,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', workspacePath, '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
						cwd: workspacePath,
					})
				)
			})

			it('should not set cwd in headless mode when addDir is not specified', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
					})
				)

				// Ensure cwd is not in the options
				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[2]).not.toHaveProperty('cwd')
			})

			it('should add --output-format stream-json in headless mode always', async () => {
				const prompt = 'Test prompt'

				// Mock logger to return true for debug enabled
				vi.mocked(logger.isDebugEnabled).mockReturnValue(true)

				// Mock process.stdout.write to capture the streaming output
				const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}',
					exitCode: 0,
				} as MockExecaReturn)

				const result = await launchClaude(prompt, {
					headless: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
						verbose: true, // Debug mode enabled
					})
				)

				// Verify JSON output was written to stdout
				expect(stdoutSpy).toHaveBeenCalledWith('{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}')
				expect(result).toBe('{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}')

				stdoutSpy.mockRestore()
				// Reset logger mock
				vi.mocked(logger.isDebugEnabled).mockReturnValue(false)
			})

			it('should show progress dots in non-debug mode with JSON streaming', async () => {
				const prompt = 'Test prompt'

				// Mock logger to return false for debug disabled (non-debug mode)
				vi.mocked(logger.isDebugEnabled).mockReturnValue(false)

				// Mock process.stdout.write to capture the progress dots
				const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '{"type":"result","result":"Hello World"}',
					exitCode: 0,
				} as MockExecaReturn)

				const result = await launchClaude(prompt, {
					headless: true,
				})

				// Verify --output-format stream-json is still added in non-debug mode
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
						verbose: false, // Debug mode disabled
					})
				)

				// Verify progress dots were shown instead of full JSON, followed by cleanup newline
				expect(stdoutSpy).toHaveBeenCalledWith('🤖 .')
				expect(stdoutSpy).toHaveBeenCalledWith('\n')

				// Verify result is parsed from JSON
				expect(result).toBe('Hello World')

				stdoutSpy.mockRestore()
			})

			it('should throw error with context when Claude CLI fails', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockRejectedValueOnce({
					stderr: 'API error',
					message: 'Command failed',
					exitCode: 1,
				})

				await expect(launchClaude(prompt, { headless: true })).rejects.toThrow(
					'Claude CLI error: API error'
				)
			})

			it('should use message when stderr is not available', async () => {
				const prompt = 'Test prompt'
				vi.mocked(execa).mockRejectedValueOnce({
					message: 'Network timeout',
					exitCode: 1,
				})

				await expect(launchClaude(prompt, { headless: true })).rejects.toThrow(
					'Claude CLI error: Network timeout'
				)
			})
		})

		describe('interactive mode', () => {
			it('should launch in interactive mode in current terminal with stdio inherit', async () => {
				const prompt = 'Resolve conflicts'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				const result = await launchClaude(prompt, { headless: false })

				expect(result).toBeUndefined()
				// Interactive mode runs in current terminal with stdio: inherit
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: 'inherit',
						timeout: 0
					})
				)
			})

			it('should include model and permission-mode flags in interactive mode', async () => {
				const prompt = 'Resolve conflicts'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					model: 'opus',
					permissionMode: 'plan',
					addDir: '/workspace',
				})

				// Interactive mode runs in current terminal with all flags
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--model', 'opus', '--permission-mode', 'plan', '--add-dir', '/workspace', '--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: 'inherit'
					})
				)
			})

			it('should set cwd to addDir in interactive mode when addDir is specified', async () => {
				const prompt = 'Resolve conflicts'
				const workspacePath = '/path/to/workspace'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					addDir: workspacePath,
				})

				// Verify cwd is set to workspace path
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', workspacePath, '--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						cwd: workspacePath,
						stdio: 'inherit'
					})
				)
			})

			it('should not set cwd in interactive mode when addDir is not specified', async () => {
				const prompt = 'Resolve conflicts'
				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
				})

				// Verify cwd is not set
				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[2]).not.toHaveProperty('cwd')
			})

			it('should use simple -- prompt format for interactive mode when appendSystemPrompt not provided', async () => {
				const prompt = 'Resolve the merge conflicts'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
				})

				// Verify simple -- prompt format is used (NOT --append-system-prompt)
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: 'inherit'
					})
				)
			})

			it('should handle branchName option without applying terminal colors', async () => {
				const prompt = 'Resolve conflicts'
				const branchName = 'feat/issue-123-test'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					branchName, // branchName is ignored in simple interactive mode
				})

				// Verify simple command without terminal window manipulation
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: 'inherit'
					})
				)
			})
		})

		describe('appendSystemPrompt parameter', () => {
			it('should use --append-system-prompt flag when provided in interactive mode', async () => {
				const systemPrompt = 'You are a helpful assistant. Follow these steps...'
				const userPrompt = 'Go!'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(userPrompt, {
					headless: false,
					appendSystemPrompt: systemPrompt,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--append-system-prompt', systemPrompt, '--', userPrompt],
					expect.objectContaining({
						stdio: 'inherit',
						timeout: 0,
					})
				)
			})

			it('should include all flags with --append-system-prompt in correct order', async () => {
				const systemPrompt = 'System instructions'
				const userPrompt = 'Go!'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(userPrompt, {
					headless: false,
					model: 'claude-sonnet-4-20250514',
					permissionMode: 'acceptEdits',
					addDir: '/workspace',
					appendSystemPrompt: systemPrompt,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'--model', 'claude-sonnet-4-20250514',
						'--permission-mode', 'acceptEdits',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--append-system-prompt', systemPrompt,
						'--', userPrompt
					],
					expect.objectContaining({
						stdio: 'inherit',
						timeout: 0,
						cwd: '/workspace',
					})
				)
			})

			it('should handle special characters in appendSystemPrompt via execa', async () => {
				const systemPrompt = 'Instructions with "quotes" and \'apostrophes\' and $variables'
				const userPrompt = 'Go!'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(userPrompt, {
					headless: false,
					appendSystemPrompt: systemPrompt,
				})

				// execa handles escaping automatically, so we just pass the raw string
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--append-system-prompt', systemPrompt, '--', userPrompt],
					expect.any(Object)
				)
			})

			it('should work with appendSystemPrompt in headless mode', async () => {
				const systemPrompt = 'You are a branch name generator'
				const userPrompt = 'Generate branch name'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'feat/issue-123-test',
					exitCode: 0,
				} as MockExecaReturn)

				const result = await launchClaude(userPrompt, {
					headless: true,
					model: 'sonnet',
					appendSystemPrompt: systemPrompt,
				})

				expect(result).toBe('feat/issue-123-test')
				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'sonnet',
						'--add-dir', '/tmp',
						'--append-system-prompt', systemPrompt
					],
					expect.objectContaining({
						input: userPrompt,
						timeout: 0,
					})
				)
			})

			it('should still use simple format when appendSystemPrompt not provided', async () => {
				const prompt = 'Resolve conflicts'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
				})

				// Should use simple -- format without --append-system-prompt
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: 'inherit',
					})
				)
			})
		})

		describe('mcpConfig parameter', () => {
			it('should add --mcp-config flags for each config in array', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [
					{
						issue_management: {
							command: 'node',
							args: ['server.js'],
							env: { REPO_OWNER: 'test', REPO_NAME: 'repo' }
						}
					},
					{
						another_server: {
							command: 'node',
							args: ['another.js'],
							env: { KEY: 'value' }
						}
					}
				]

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					mcpConfig: mcpConfigs,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--mcp-config', JSON.stringify(mcpConfigs[0]),
						'--mcp-config', JSON.stringify(mcpConfigs[1])
					],
					expect.any(Object)
				)
			})

			it('should add single --mcp-config when only one config provided', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [
					{
						issue_management: {
							command: 'node',
							args: ['server.js'],
							env: { REPO_OWNER: 'test' }
						}
					}
				]

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					mcpConfig: mcpConfigs,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--mcp-config', JSON.stringify(mcpConfigs[0])
					],
					expect.any(Object)
				)
			})

			it('should not add --mcp-config when array is empty', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					mcpConfig: [],
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should not add --mcp-config when option not provided', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, { headless: true })

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[1]).not.toContain('--mcp-config')
			})

			it('should work with mcpConfig in interactive mode', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [
					{
						issue_management: {
							command: 'node',
							args: ['server.js'],
							env: { KEY: 'value' }
						}
					}
				]

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					mcpConfig: mcpConfigs,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'--add-dir', '/tmp',
						'--mcp-config', JSON.stringify(mcpConfigs[0]),
						'--', prompt
					],
					expect.objectContaining({
						stdio: 'inherit'
					})
				)
			})

			it('should combine mcpConfig with other options', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [{ server: { command: 'node', args: ['s.js'] } }]

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					permissionMode: 'plan',
					addDir: '/workspace',
					mcpConfig: mcpConfigs,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--permission-mode', 'plan',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--mcp-config', JSON.stringify(mcpConfigs[0])
					],
					expect.any(Object)
				)
			})
		})

		describe('allowedTools and disallowedTools parameters', () => {
			it('should add --allowed-tools flags when allowedTools provided', async () => {
				const prompt = 'Test prompt'
				const allowedTools = ['mcp__issue_management__create_comment', 'mcp__issue_management__update_comment']

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					allowedTools,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--allowed-tools', ...allowedTools
					],
					expect.any(Object)
				)
			})

			it('should add --disallowed-tools flags when disallowedTools provided', async () => {
				const prompt = 'Test prompt'
				const disallowedTools = ['Bash(gh api:*)']

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					disallowedTools,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--disallowed-tools', ...disallowedTools
					],
					expect.any(Object)
				)
			})

			it('should add both --allowed-tools and --disallowed-tools when both provided', async () => {
				const prompt = 'Test prompt'
				const allowedTools = ['mcp__issue_management__create_comment', 'mcp__issue_management__update_comment']
				const disallowedTools = ['Bash(gh api:*)']

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					allowedTools,
					disallowedTools,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--allowed-tools', ...allowedTools,
						'--disallowed-tools', ...disallowedTools
					],
					expect.any(Object)
				)
			})

			it('should not add --allowed-tools when array is empty', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					allowedTools: [],
				})

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[1]).not.toContain('--allowed-tools')
			})

			it('should not add --disallowed-tools when array is empty', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					disallowedTools: [],
				})

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[1]).not.toContain('--disallowed-tools')
			})

			it('should not add tool filtering flags when options not provided', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, { headless: true })

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[1]).not.toContain('--allowed-tools')
				expect(execaCall[1]).not.toContain('--disallowed-tools')
			})

			it('should work with tool filtering in interactive mode', async () => {
				const prompt = 'Test prompt'
				const allowedTools = ['mcp__issue_management__create_comment']
				const disallowedTools = ['Bash(gh api:*)']

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					allowedTools,
					disallowedTools,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'--add-dir', '/tmp',
						'--allowed-tools', ...allowedTools,
						'--disallowed-tools', ...disallowedTools,
						'--', prompt
					],
					expect.objectContaining({
						stdio: 'inherit'
					})
				)
			})

			it('should combine tool filtering with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [{ server: { command: 'node', args: ['s.js'] } }]
				const allowedTools = ['mcp__issue_management__create_comment']
				const disallowedTools = ['Bash(gh api:*)']

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					permissionMode: 'plan',
					addDir: '/workspace',
					appendSystemPrompt: 'System instructions',
					mcpConfig: mcpConfigs,
					allowedTools,
					disallowedTools,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--permission-mode', 'plan',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--append-system-prompt', 'System instructions',
						'--mcp-config', JSON.stringify(mcpConfigs[0]),
						'--allowed-tools', ...allowedTools,
						'--disallowed-tools', ...disallowedTools
					],
					expect.any(Object)
				)
			})
		})

		describe('agents parameter', () => {
			it('should include --agents flag when agents provided', async () => {
				const prompt = 'Test prompt'
				const agents = {
					'test-agent': {
						description: 'Test agent',
						prompt: 'You are a test agent',
						tools: ['Read', 'Write'],
						model: 'sonnet',
					},
				}

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					agents,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--agents', JSON.stringify(agents)],
					expect.any(Object),
				)
			})

			it('should omit --agents flag when agents not provided', async () => {
				const prompt = 'Test prompt'

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, { headless: true })

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[1]).not.toContain('--agents')
			})

			it('should properly JSON.stringify agents object', async () => {
				const prompt = 'Test prompt'
				const agents = {
					'agent-1': {
						description: 'First agent',
						prompt: 'Agent 1 prompt',
						tools: ['Read', 'Write'],
						model: 'sonnet',
						color: 'blue',
					},
					'agent-2': {
						description: 'Second agent',
						prompt: 'Agent 2 prompt',
						tools: ['Edit', 'Bash'],
						model: 'opus',
						color: 'green',
					},
				}

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					agents,
				})

				// Verify JSON.stringify was used
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--agents', JSON.stringify(agents)],
					expect.any(Object),
				)
			})

			it('should handle large agent prompts without truncation', async () => {
				const prompt = 'Test prompt'
				const longPrompt = 'A'.repeat(5000) // 5000 character prompt
				const agents = {
					'large-agent': {
						description: 'Agent with large prompt',
						prompt: longPrompt,
						tools: ['Read'],
						model: 'sonnet',
					},
				}

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					agents,
				})

				const execaCall = vi.mocked(execa).mock.calls[0]
				const agentsArg = execaCall[1][execaCall[1].indexOf('--agents') + 1]
				const parsedAgents = JSON.parse(agentsArg as string)

				expect(parsedAgents['large-agent'].prompt).toBe(longPrompt)
				expect(parsedAgents['large-agent'].prompt.length).toBe(5000)
			})

			it('should work with agents in interactive mode', async () => {
				const prompt = 'Test prompt'
				const agents = {
					'test-agent': {
						description: 'Test agent',
						prompt: 'You are a test agent',
						tools: ['Read'],
						model: 'sonnet',
					},
				}

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: false,
					agents,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--agents', JSON.stringify(agents), '--', prompt],
					expect.objectContaining({
						stdio: 'inherit',
					}),
				)
			})

			it('should combine agents with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [{ server: { command: 'node', args: ['s.js'] } }]
				const allowedTools = ['mcp__issue_management__create_comment']
				const disallowedTools = ['Bash(gh api:*)']
				const agents = {
					'test-agent': {
						description: 'Test agent',
						prompt: 'You are a test agent',
						tools: ['Read'],
						model: 'sonnet',
					},
				}

				vi.mocked(execa).mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				} as MockExecaReturn)

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					permissionMode: 'plan',
					addDir: '/workspace',
					appendSystemPrompt: 'System instructions',
					mcpConfig: mcpConfigs,
					allowedTools,
					disallowedTools,
					agents,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model',
						'opus',
						'--permission-mode',
						'plan',
						'--add-dir',
						'/workspace',
						'--add-dir',
						'/tmp',
						'--append-system-prompt',
						'System instructions',
						'--mcp-config',
						JSON.stringify(mcpConfigs[0]),
						'--allowed-tools',
						...allowedTools,
						'--disallowed-tools',
						...disallowedTools,
						'--agents',
						JSON.stringify(agents),
					],
					expect.any(Object),
				)
			})
		})
	})

	describe.runIf(process.platform === 'darwin')('launchClaudeInNewTerminalWindow', () => {
		it('should open new terminal window with iloom spin command', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify osascript was called for terminal window with iloom spin command
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('iloom spin')
			expect(execa).toHaveBeenCalledWith(
				'osascript',
				['-e', expect.stringContaining('tell application "Terminal"')]
			)
		})

		it('should throw error when workspacePath not provided', async () => {
			const prompt = 'Test prompt'

			await expect(
				launchClaudeInNewTerminalWindow(prompt, {} as unknown as { workspacePath: string })
			).rejects.toThrow(/workspacePath.*required/i)
		})

		it('should apply branch-specific background color when branchName provided', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'
			const branchName = 'feat/issue-123-test'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, branchName })

			// Verify terminal window was opened with iloom spin
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('iloom spin')
			expect(execa).toHaveBeenCalledWith(
				'osascript',
				['-e', expect.stringContaining('tell application "Terminal"')]
			)
		})

		it('should include .env sourcing when .env file exists in workspace', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			// Mock .env file exists
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify .env sourcing is included and iloom spin is used
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('source .env')
			expect(applescript).toContain('iloom spin')
			expect(existsSync).toHaveBeenCalledWith('/path/to/workspace/.env')
		})

		it('should not include .env sourcing when .env file does not exist', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			// Mock .env file does not exist
			vi.mocked(existsSync).mockReturnValue(false)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify .env sourcing is NOT included but iloom spin is used
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).not.toContain('source .env')
			expect(applescript).toContain('iloom spin')
		})

		it('should not build complex claude command with prompt', async () => {
			const prompt = "Fix the user's \"authentication\" issue"
			const workspacePath = '/path/to/workspace'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify simple iloom spin command is used, not complex claude command with prompt
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('iloom spin')
			expect(applescript).not.toContain('--append-system-prompt')
			expect(applescript).not.toContain(prompt)
		})

		it('should use iloom spin instead of building claude command with args', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify iloom spin is used, not claude with model/permission args
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('iloom spin')
			expect(applescript).not.toContain('--model')
			expect(applescript).not.toContain('--permission-mode')
			expect(applescript).not.toContain('--add-dir')
		})

		it('should export PORT variable when port is provided', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'
			const port = 3127

			vi.mocked(existsSync).mockReturnValue(false)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, port })

			// Verify PORT export is included in AppleScript
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('export PORT=3127')
			expect(applescript).toContain('iloom spin')
		})

		it('should not export PORT when port is undefined', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			vi.mocked(existsSync).mockReturnValue(false)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify PORT export is NOT included
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).not.toContain('export PORT')
		})

		it('should combine port export with .env sourcing when both present', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'
			const port = 3127

			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, port })

			// Verify both .env sourcing and PORT export
			const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('source .env')
			expect(applescript).toContain('export PORT=3127')
			expect(applescript).toContain('iloom spin')
		})
	})

	describe('generateBranchName', () => {
		it('should generate branch name using Claude when available', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude response with full branch name
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'feat/issue-123-user-authentication',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123-user-authentication')
			expect(execa).toHaveBeenCalledWith(
				'claude',
				['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--add-dir', '/tmp'],
				expect.objectContaining({
					input: expect.stringContaining(issueTitle),
				})
			)
		})

		it('should use fallback when Claude CLI is not available', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI not found
			vi.mocked(execa).mockRejectedValueOnce({
				exitCode: 1,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should use fallback when Claude returns invalid output', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude returning error message
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'API error: rate limit exceeded',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should use fallback when Claude returns empty output', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude returning empty string
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should accept valid branch name from Claude', async () => {
			const issueTitle = 'Fix bug'
			const issueNumber = 123

			// Mock Claude CLI detection
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude returning properly formatted branch
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'fix/issue-123-authentication-bug',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('fix/issue-123-authentication-bug')
		})

		it('should reject invalid branch name format from Claude', async () => {
			const issueTitle = 'Add feature'
			const issueNumber = 456

			// Mock Claude CLI detection
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude returning invalid format (no prefix)
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'add-user-auth',
				exitCode: 0,
			} as MockExecaReturn)

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-456')
		})

		it('should use fallback when Claude CLI throws error', async () => {
			const issueTitle = 'Add feature'
			const issueNumber = 456

			// Mock Claude CLI detection succeeds
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			} as MockExecaReturn)

			// Mock Claude execution fails
			vi.mocked(execa).mockRejectedValueOnce({
				stderr: 'Claude error',
				exitCode: 1,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-456')
		})
	})
})
