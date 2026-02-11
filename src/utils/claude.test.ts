import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { detectClaudeCli, getClaudeVersion, launchClaude, generateBranchName, launchClaudeInNewTerminalWindow, generateDeterministicSessionId, generateRandomSessionId } from './claude.js'
import { logger } from './logger.js'

const mockLogger = {
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	success: vi.fn(),
	setDebug: vi.fn(),
	isDebugEnabled: vi.fn().mockReturnValue(false),
	stdout: {
		write: vi.fn().mockReturnValue(true),
	},
}

vi.mock('execa')
vi.mock('node:fs')
vi.mock('./logger.js', () => ({
	logger: {
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		isDebugEnabled: vi.fn().mockReturnValue(false),
		stdout: {
			write: vi.fn().mockReturnValue(true),
		},
	},
}))
vi.mock('./logger-context.js', () => ({
	getLogger: vi.fn(() => mockLogger),
}))

// Helper to mock execa - cast to any to bypass complex generic overloads
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExeca = () => vi.mocked(execa) as any

describe('claude utils', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('generateDeterministicSessionId', () => {
		it('should generate a valid UUID v5 format', () => {
			const path = '/path/to/workspace'
			const sessionId = generateDeterministicSessionId(path)

			// Verify UUID format: 8-4-4-4-12 hex characters
			expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		})

		it('should be deterministic - same path produces same UUID', () => {
			const path = '/path/to/workspace'
			const sessionId1 = generateDeterministicSessionId(path)
			const sessionId2 = generateDeterministicSessionId(path)

			expect(sessionId1).toBe(sessionId2)
		})

		it('should produce different UUIDs for different paths', () => {
			const sessionId1 = generateDeterministicSessionId('/path/to/workspace1')
			const sessionId2 = generateDeterministicSessionId('/path/to/workspace2')

			expect(sessionId1).not.toBe(sessionId2)
		})

		it('should handle paths with special characters', () => {
			const path = '/path/with spaces/and-dashes/and_underscores'
			const sessionId = generateDeterministicSessionId(path)

			expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		})

		it('should handle empty string path', () => {
			const sessionId = generateDeterministicSessionId('')

			expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		})

		it('should handle very long paths', () => {
			const longPath = '/a'.repeat(500)
			const sessionId = generateDeterministicSessionId(longPath)

			expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		})
	})

	describe('generateRandomSessionId', () => {
		it('should generate a valid UUID v4 format', () => {
			const sessionId = generateRandomSessionId()

			// Verify UUID v4 format: 8-4-4-4-12 hex characters with version 4 marker
			expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		})

		it('should generate unique UUIDs on each call', () => {
			const sessionId1 = generateRandomSessionId()
			const sessionId2 = generateRandomSessionId()
			const sessionId3 = generateRandomSessionId()

			expect(sessionId1).not.toBe(sessionId2)
			expect(sessionId2).not.toBe(sessionId3)
			expect(sessionId1).not.toBe(sessionId3)
		})

		it('should generate multiple unique UUIDs in rapid succession', () => {
			const sessionIds = new Set<string>()
			for (let i = 0; i < 100; i++) {
				sessionIds.add(generateRandomSessionId())
			}

			// All 100 generated UUIDs should be unique
			expect(sessionIds.size).toBe(100)
		})
	})

	describe('detectClaudeCli', () => {
		it('should return true when Claude CLI is found', async () => {
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			const result = await detectClaudeCli()

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith('command', ['-v', 'claude'], {
				shell: true,
				timeout: 5000,
			})
		})

		it('should return false when Claude CLI is not found', async () => {
			mockExeca().mockRejectedValueOnce({
				exitCode: 1,
				stderr: 'command not found',
			})

			const result = await detectClaudeCli()

			expect(result).toBe(false)
		})

		it('should return false when command times out', async () => {
			mockExeca().mockRejectedValueOnce({
				message: 'Timeout',
			})

			const result = await detectClaudeCli()

			expect(result).toBe(false)
		})
	})

	describe('getClaudeVersion', () => {
		it('should return version when Claude CLI is available', async () => {
			const version = '1.2.3'
			mockExeca().mockResolvedValueOnce({
				stdout: version,
				exitCode: 0,
			})

			const result = await getClaudeVersion()

			expect(result).toBe(version)
			expect(execa).toHaveBeenCalledWith('claude', ['--version'], {
				timeout: 5000,
			})
		})

		it('should return null when Claude CLI is not available', async () => {
			mockExeca().mockRejectedValueOnce({
				exitCode: 1,
				stderr: 'command not found',
			})

			const result = await getClaudeVersion()

			expect(result).toBeNull()
		})

		it('should trim whitespace from version string', async () => {
			mockExeca().mockResolvedValueOnce({
				stdout: '  1.2.3\n',
				exitCode: 0,
			})

			const result = await getClaudeVersion()

			expect(result).toBe('1.2.3')
		})
	})

	describe('launchClaude', () => {
		describe('headless mode', () => {
			it('should launch in headless mode and return output', async () => {
				const prompt = 'Generate a branch name'
				const output = 'feat/issue-123__new-feature'

				mockExeca().mockResolvedValueOnce({
					stdout: output,
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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
				const execaCall = mockExeca().mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
				expect(execaCall[2]).not.toHaveProperty('cwd')
			})

			it('should add --output-format stream-json in headless mode always', async () => {
				const prompt = 'Test prompt'

				// Mock logger to return true for debug enabled
				vi.mocked(logger.isDebugEnabled).mockReturnValue(true)

				mockExeca().mockResolvedValueOnce({
					stdout: '{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}',
					exitCode: 0,
				})

				const result = await launchClaude(prompt, {
					headless: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--debug'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
						verbose: true, // Debug mode enabled
					})
				)

				// Verify JSON output was written to logger.stdout
				expect(mockLogger.stdout.write).toHaveBeenCalledWith('{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}')
				expect(result).toBe('{"type":"message","text":"Hello"}\n{"type":"thinking","text":"Let me think"}')

				// Reset logger mock
				vi.mocked(logger.isDebugEnabled).mockReturnValue(false)
			})

			it('should show progress dots in non-debug mode with JSON streaming', async () => {
				const prompt = 'Test prompt'

				// Mock logger to return false for debug disabled (non-debug mode)
				vi.mocked(logger.isDebugEnabled).mockReturnValue(false)

				mockExeca().mockResolvedValueOnce({
					stdout: '{"type":"result","result":"Hello World"}',
					exitCode: 0,
				})

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
				expect(mockLogger.stdout.write).toHaveBeenCalledWith('🤖 .')
				expect(mockLogger.stdout.write).toHaveBeenCalledWith('\n')

				// Verify result is parsed from JSON
				expect(result).toBe('Hello World')
			})

			it('should throw error with context when Claude CLI fails', async () => {
				const prompt = 'Test prompt'
				mockExeca().mockRejectedValueOnce({
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
				mockExeca().mockRejectedValueOnce({
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
				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				const result = await launchClaude(prompt, { headless: false })

				expect(result).toBeUndefined()
				// Interactive mode runs in current terminal with stdio array (pipe stderr for error detection)
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
						timeout: 0
					})
				)
			})

			it('should include model and permission-mode flags in interactive mode', async () => {
				const prompt = 'Resolve conflicts'
				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})

			it('should set cwd to addDir in interactive mode when addDir is specified', async () => {
				const prompt = 'Resolve conflicts'
				const workspacePath = '/path/to/workspace'
				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})

			it('should not set cwd in interactive mode when addDir is not specified', async () => {
				const prompt = 'Resolve conflicts'
				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
				})

				// Verify cwd is not set
				const execaCall = mockExeca().mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
				expect(execaCall[2]).not.toHaveProperty('cwd')
			})

			it('should use simple -- prompt format for interactive mode when appendSystemPrompt not provided', async () => {
				const prompt = 'Resolve the merge conflicts'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
				})

				// Verify simple -- prompt format is used (NOT --append-system-prompt)
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})

			it('should handle branchName option without applying terminal colors', async () => {
				const prompt = 'Resolve conflicts'
				const branchName = 'feat/issue-123__test'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					branchName, // branchName is ignored in simple interactive mode
				})

				// Verify simple command without terminal window manipulation
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})
		})

		describe('appendSystemPrompt parameter', () => {
			it('should use --append-system-prompt flag when provided in interactive mode', async () => {
				const systemPrompt = 'You are a helpful assistant. Follow these steps...'
				const userPrompt = 'Go!'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(userPrompt, {
					headless: false,
					appendSystemPrompt: systemPrompt,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--append-system-prompt', systemPrompt, '--', userPrompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
						timeout: 0,
					})
				)
			})

			it('should include all flags with --append-system-prompt in correct order', async () => {
				const systemPrompt = 'System instructions'
				const userPrompt = 'Go!'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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
						stdio: ['inherit', 'inherit', 'pipe'],
						timeout: 0,
						cwd: '/workspace',
					})
				)
			})

			it('should handle special characters in appendSystemPrompt via execa', async () => {
				const systemPrompt = 'Instructions with "quotes" and \'apostrophes\' and $variables'
				const userPrompt = 'Go!'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'feat/issue-123__test',
					exitCode: 0,
				})

				const result = await launchClaude(userPrompt, {
					headless: true,
					model: 'sonnet',
					appendSystemPrompt: systemPrompt,
				})

				expect(result).toBe('feat/issue-123__test')
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

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
				})

				// Should use simple -- format without --append-system-prompt
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
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

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})

			it('should combine mcpConfig with other options', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [{ server: { command: 'node', args: ['s.js'] } }]

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					allowedTools: [],
				})

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--allowed-tools')
			})

			it('should not add --disallowed-tools when array is empty', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					disallowedTools: [],
				})

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--disallowed-tools')
			})

			it('should not add tool filtering flags when options not provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--allowed-tools')
				expect(execaCall[1]).not.toContain('--disallowed-tools')
			})

			it('should work with tool filtering in interactive mode', async () => {
				const prompt = 'Test prompt'
				const allowedTools = ['mcp__issue_management__create_comment']
				const disallowedTools = ['Bash(gh api:*)']

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

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
						stdio: ['inherit', 'inherit', 'pipe']
					})
				)
			})

			it('should combine tool filtering with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const mcpConfigs = [{ server: { command: 'node', args: ['s.js'] } }]
				const allowedTools = ['mcp__issue_management__create_comment']
				const disallowedTools = ['Bash(gh api:*)']

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					agents,
				})

				const execaCall = mockExeca().mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
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

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					agents,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--agents', JSON.stringify(agents), '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
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

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

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

		describe('sessionId parameter', () => {
			it('should include --session-id flag when sessionId provided', async () => {
				const prompt = 'Test prompt'
				const sessionId = '12345678-1234-5678-1234-567812345678'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					sessionId,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--session-id', sessionId],
					expect.any(Object)
				)
			})

			it('should omit --session-id flag when sessionId not provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--session-id')
			})

			it('should work with sessionId in interactive mode', async () => {
				const prompt = 'Test prompt'
				const sessionId = '12345678-1234-5678-1234-567812345678'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					sessionId,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--session-id', sessionId, '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
					})
				)
			})

			it('should combine sessionId with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const sessionId = '12345678-1234-5678-1234-567812345678'
				const agents = { 'test-agent': { description: 'Test', prompt: 'Test', tools: ['Read'], model: 'sonnet' } }

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					addDir: '/workspace',
					agents,
					sessionId,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--agents', JSON.stringify(agents),
						'--session-id', sessionId,
					],
					expect.any(Object)
				)
			})

			it('should retry with --resume when session ID is already in use (headless mode)', async () => {
				const prompt = 'Test prompt'
				const sessionId = '01af28fe-8630-4778-ae85-39398ab84f54'

				// First call fails with "Session ID already in use"
				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${sessionId} is already in use.`,
					exitCode: 1,
				})

				// Retry with --resume succeeds
				mockExeca().mockResolvedValueOnce({
					stdout: 'resumed output',
					exitCode: 0,
				})

				const result = await launchClaude(prompt, {
					headless: true,
					sessionId,
				})

				expect(result).toBe('resumed output')
				expect(execa).toHaveBeenCalledTimes(2)

				// Verify first call used --session-id with prompt as input
				expect(execa).toHaveBeenNthCalledWith(
					1,
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--session-id', sessionId],
					expect.objectContaining({ input: prompt })
				)

				// Verify retry used --resume instead of --session-id
				// Note: In headless mode, prompt is still passed via input since there's no interactive mechanism
				expect(execa).toHaveBeenNthCalledWith(
					2,
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--resume', sessionId],
					expect.objectContaining({ input: prompt })
				)
			})

			it('should retry with --resume when session ID is already in use (interactive mode)', async () => {
				const prompt = 'Test prompt'
				const sessionId = '01af28fe-8630-4778-ae85-39398ab84f54'

				// First call fails with "Session ID already in use"
				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${sessionId} is already in use.`,
					exitCode: 1,
				})

				// Retry with --resume succeeds
				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					sessionId,
				})

				expect(execa).toHaveBeenCalledTimes(2)

				// Verify first call used --session-id with piped stderr for error detection
				expect(execa).toHaveBeenNthCalledWith(
					1,
					'claude',
					['--add-dir', '/tmp', '--session-id', sessionId, '--', prompt],
					expect.objectContaining({ stdio: ['inherit', 'inherit', 'pipe'] })
				)

				// Verify retry used --resume with full inherit for interactive experience
				// Note: prompt is omitted when using --resume since the session already has context
				expect(execa).toHaveBeenNthCalledWith(
					2,
					'claude',
					['--add-dir', '/tmp', '--resume', sessionId],
					expect.objectContaining({ stdio: 'inherit' })
				)
			})

			it('should not retry if sessionId is not provided', async () => {
				const prompt = 'Test prompt'
				const sessionId = '01af28fe-8630-4778-ae85-39398ab84f54'

				// Call fails with "Session ID already in use" but sessionId option not provided
				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${sessionId} is already in use.`,
					exitCode: 1,
				})

				await expect(launchClaude(prompt, { headless: true })).rejects.toThrow(
					`Claude CLI error: Error: Session ID ${sessionId} is already in use.`
				)

				expect(execa).toHaveBeenCalledTimes(1)
			})

			it('should throw error if retry also fails', async () => {
				const prompt = 'Test prompt'
				const sessionId = '01af28fe-8630-4778-ae85-39398ab84f54'

				// First call fails with "Session ID already in use"
				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${sessionId} is already in use.`,
					exitCode: 1,
				})

				// Retry also fails
				mockExeca().mockRejectedValueOnce({
					stderr: 'Some other error on retry',
					exitCode: 1,
				})

				await expect(launchClaude(prompt, {
					headless: true,
					sessionId,
				})).rejects.toThrow('Claude CLI error: Some other error on retry')

				expect(execa).toHaveBeenCalledTimes(2)
			})

			it('should extract session ID from error message correctly', async () => {
				const prompt = 'Test prompt'
				const providedSessionId = '01af28fe-8630-4778-ae85-39398ab84f54'
				const errorSessionId = 'abcd1234-5678-90ab-cdef-1234567890ab'

				// First call fails with different session ID in error
				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${errorSessionId} is already in use.`,
					exitCode: 1,
				})

				// Retry with extracted session ID succeeds
				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					sessionId: providedSessionId,
				})

				// Verify retry uses the session ID from error message, not the provided one
				expect(execa).toHaveBeenNthCalledWith(
					2,
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--resume', errorSessionId],
					expect.any(Object)
				)
			})

			it('should preserve other args when retrying with --resume but omit prompt', async () => {
				const prompt = 'Test prompt'
				const sessionId = '01af28fe-8630-4778-ae85-39398ab84f54'

				mockExeca().mockRejectedValueOnce({
					stderr: `Error: Session ID ${sessionId} is already in use.`,
					exitCode: 1,
				})

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					addDir: '/workspace',
					sessionId,
				})

				// Verify retry preserves model and addDir but replaces --session-id with --resume
				// In headless mode, prompt is still passed via input since there's no interactive mechanism
				expect(execa).toHaveBeenNthCalledWith(
					2,
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--resume', sessionId,
					],
					expect.objectContaining({ input: prompt })
				)
			})
		})

		describe('outputFormat parameter', () => {
			it('should use user-provided outputFormat when headless=true', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					outputFormat: 'json',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should default to stream-json when headless=true and no outputFormat provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should support text output format', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					outputFormat: 'text',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'text', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})
		})

		describe('verbose parameter', () => {
			it('should use user-provided verbose=false to disable verbose output', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					verbose: false,
				})

				// Should NOT include --verbose
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should default to verbose=true when headless=true', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should include --verbose when verbose=true is explicitly set', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					verbose: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should combine outputFormat and verbose options correctly', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					outputFormat: 'json',
					verbose: false,
				})

				// Should use json format without --verbose
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'json', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})
		})

		describe('noSessionPersistence parameter', () => {
			it('should add --no-session-persistence flag when noSessionPersistence is true', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					noSessionPersistence: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp', '--no-session-persistence'],
					expect.any(Object)
				)
			})

			it('should not add --no-session-persistence flag when noSessionPersistence is false', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					noSessionPersistence: false,
				})

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--no-session-persistence')
			})

			it('should not add --no-session-persistence flag when noSessionPersistence is undefined', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--no-session-persistence')
			})

			it('should NOT add noSessionPersistence in interactive mode (only works with --print)', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					noSessionPersistence: true, // Should be ignored in interactive mode
				})

				// --no-session-persistence should NOT be added since it only works with -p/--print mode
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
					})
				)
			})

			it('should combine noSessionPersistence with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const sessionId = '12345678-1234-5678-1234-567812345678'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					addDir: '/workspace',
					sessionId,
					noSessionPersistence: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--session-id', sessionId,
						'--no-session-persistence',
					],
					expect.any(Object)
				)
			})
		})
	})

	describe.runIf(process.platform === 'darwin')('launchClaudeInNewTerminalWindow', () => {
		it('should open new terminal window with iloom spin command', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify osascript was called for terminal window with iloom spin command
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
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
			const branchName = 'feat/issue-123__test'

			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, branchName })

			// Verify terminal window was opened with iloom spin
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
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
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify .env sourcing is included and iloom spin is used
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('source .env')
			expect(applescript).toContain('iloom spin')
			expect(existsSync).toHaveBeenCalledWith('/path/to/workspace/.env')
		})

		it('should not include .env sourcing when .env file does not exist', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			// Mock .env file does not exist
			vi.mocked(existsSync).mockReturnValue(false)
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify .env sourcing is NOT included but iloom spin is used
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
			expect(applescript).not.toContain('source .env')
			expect(applescript).toContain('iloom spin')
		})

		it('should not build complex claude command with prompt', async () => {
			const prompt = "Fix the user's \"authentication\" issue"
			const workspacePath = '/path/to/workspace'

			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify simple iloom spin command is used, not complex claude command with prompt
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('iloom spin')
			expect(applescript).not.toContain('--append-system-prompt')
			expect(applescript).not.toContain(prompt)
		})

		it('should use iloom spin instead of building claude command with args', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify iloom spin is used, not claude with model/permission args
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
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
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, port })

			// Verify PORT export is included in AppleScript
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
			expect(applescript).toContain('export PORT=3127')
			expect(applescript).toContain('iloom spin')
		})

		it('should not export PORT when port is undefined', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'

			vi.mocked(existsSync).mockReturnValue(false)
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath })

			// Verify PORT export is NOT included
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
			expect(applescript).not.toContain('export PORT')
		})

		it('should combine port export with .env sourcing when both present', async () => {
			const prompt = 'Work on this issue'
			const workspacePath = '/path/to/workspace'
			const port = 3127

			vi.mocked(existsSync).mockReturnValue(true)
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			await launchClaudeInNewTerminalWindow(prompt, { workspacePath, port })

			// Verify both .env sourcing and PORT export
			const applescript = mockExeca().mock.calls[0][1]?.[1] as string
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
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude response with full branch name
			mockExeca().mockResolvedValueOnce({
				stdout: 'feat/issue-123__user-authentication',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123__user-authentication')
			expect(execa).toHaveBeenCalledWith(
				'claude',
				['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--add-dir', '/tmp', '--no-session-persistence'],
				expect.objectContaining({
					input: expect.stringContaining(issueTitle),
				})
			)
		})

		it('should use fallback when Claude CLI is not available', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI not found
			mockExeca().mockRejectedValueOnce({
				exitCode: 1,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should use fallback when Claude returns invalid output', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude returning error message
			mockExeca().mockResolvedValueOnce({
				stdout: 'API error: rate limit exceeded',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should use fallback when Claude returns empty output', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude returning empty string
			mockExeca().mockResolvedValueOnce({
				stdout: '',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123')
		})

		it('should accept valid branch name from Claude', async () => {
			const issueTitle = 'Fix bug'
			const issueNumber = 123

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude returning properly formatted branch
			mockExeca().mockResolvedValueOnce({
				stdout: 'fix/issue-123__authentication-bug',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('fix/issue-123__authentication-bug')
		})

		it('should reject invalid branch name format from Claude', async () => {
			const issueTitle = 'Add feature'
			const issueNumber = 456

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude returning invalid format (no prefix)
			mockExeca().mockResolvedValueOnce({
				stdout: 'add-user-auth',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-456')
		})

		it('should use fallback when Claude CLI throws error', async () => {
			const issueTitle = 'Add feature'
			const issueNumber = 456

			// Mock Claude CLI detection succeeds
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude execution fails
			mockExeca().mockRejectedValueOnce({
				stderr: 'Claude error',
				exitCode: 1,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-456')
		})

		it('should accept lowercase branch name for uppercase Linear issue ID', async () => {
			// Linear issue IDs are uppercase (e.g., MARK-1) but Claude generates lowercase branch names
			const issueTitle = 'Add Next.js Vercel integration'
			const issueNumber = 'MARK-1' // Uppercase Linear issue ID

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// Mock Claude returning lowercase branch name (correct behavior)
			mockExeca().mockResolvedValueOnce({
				stdout: 'feat/issue-mark-1__nextjs-vercel',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			// Should accept the lowercase branch name, not fall back
			expect(result).toBe('feat/issue-mark-1__nextjs-vercel')
		})
	})
})
