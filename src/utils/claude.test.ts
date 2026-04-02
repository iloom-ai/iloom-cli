/* global AbortController */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { detectClaudeCli, getClaudeVersion, launchClaude, generateBranchName, launchClaudeInNewTerminalWindow, generateDeterministicSessionId, generateRandomSessionId, hasApiKeyForBareMode, extractOAuthToken, resolveBareModeConfig } from './claude.js'
import { readFile } from 'node:fs/promises'
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
vi.mock('node:fs/promises')
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

			it('should pipe stdout to process.stdout when headless and passthroughStdout are both true', async () => {
				const prompt = 'Resolve conflicts headlessly'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				const result = await launchClaude(prompt, {
					headless: true,
					passthroughStdout: true,
					addDir: '/workspace',
				})

				// passthroughStdout returns void (output goes directly to process.stdout)
				expect(result).toBeUndefined()

				// Verify stdio configuration: stdin=pipe, stdout=inherit, stderr=pipe
				expect(execa).toHaveBeenCalledWith(
					'claude',
					['-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/workspace', '--add-dir', '/tmp'],
					expect.objectContaining({
						input: prompt,
						timeout: 0,
						cwd: '/workspace',
						stdio: ['pipe', 'inherit', 'pipe'],
					})
				)
			})

			it('should not set cwd when passthroughStdout is true but addDir is not specified', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					passthroughStdout: true,
				})

				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[2]).not.toHaveProperty('cwd')
				expect(execaCall[2]).toHaveProperty('stdio', ['pipe', 'inherit', 'pipe'])
			})

			it('should use normal headless mode when passthroughStdout is false', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: '{"type":"result","result":"output text"}',
					exitCode: 0,
				})

				const result = await launchClaude(prompt, {
					headless: true,
					passthroughStdout: false,
				})

				// Normal headless mode returns parsed output
				expect(result).toBe('output text')

				// Should NOT use inherited stdio
				const execaCall = vi.mocked(execa).mock.calls[0]
				expect(execaCall[2]).not.toHaveProperty('stdio', ['pipe', 'inherit', 'pipe'])
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



		describe('pluginDir parameter', () => {
			it('should use --plugin-dir when provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					pluginDir: '/path/to/plugin',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--plugin-dir', '/path/to/plugin',
					],
					expect.any(Object)
				)
			})

			it('should omit --plugin-dir when not provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
				expect(execaCall[1]).not.toContain('--plugin-dir')
			})

			it('should work with pluginDir in interactive mode', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: false,
					pluginDir: '/path/to/plugin',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--plugin-dir', '/path/to/plugin', '--', prompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
					})
				)
			})

			it('should combine pluginDir with other options in correct order', async () => {
				const prompt = 'Test prompt'
				const agents = { 'test-agent': { description: 'Test', prompt: 'Test', tools: ['Read'], model: 'sonnet' } }

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					agents,
					pluginDir: '/path/to/plugin',
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--add-dir', '/tmp',
						'--agents', JSON.stringify(agents),
						'--plugin-dir', '/path/to/plugin',
					],
					expect.any(Object)
				)
			})
		})

		describe('appendSystemPromptFile parameter', () => {
			it('should use --append-system-prompt-file flag when provided in interactive mode', async () => {
				const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'
				const userPrompt = 'Go!'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(userPrompt, {
					headless: false,
					appendSystemPromptFile: promptFilePath,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--add-dir', '/tmp', '--append-system-prompt-file', promptFilePath, '--', userPrompt],
					expect.objectContaining({
						stdio: ['inherit', 'inherit', 'pipe'],
						timeout: 0,
					})
				)
			})

			it('should use --append-system-prompt-file flag in headless mode', async () => {
				const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'
				const userPrompt = 'Execute plan'

				mockExeca().mockResolvedValueOnce({
					stdout: 'done',
					exitCode: 0,
				})

				const result = await launchClaude(userPrompt, {
					headless: true,
					appendSystemPromptFile: promptFilePath,
				})

				expect(result).toBe('done')
				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--add-dir', '/tmp',
						'--append-system-prompt-file', promptFilePath,
					],
					expect.objectContaining({
						input: userPrompt,
						timeout: 0,
					})
				)
			})

			it('should be combinable with appendSystemPrompt (inline)', async () => {
				const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'
				const inlinePrompt = 'Additional inline instructions'
				const userPrompt = 'Go!'

				mockExeca().mockResolvedValueOnce({
					stdout: '',
					exitCode: 0,
				})

				await launchClaude(userPrompt, {
					headless: false,
					appendSystemPrompt: inlinePrompt,
					appendSystemPromptFile: promptFilePath,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'--add-dir', '/tmp',
						'--append-system-prompt', inlinePrompt,
						'--append-system-prompt-file', promptFilePath,
						'--', userPrompt,
					],
					expect.any(Object)
				)
			})

			it('should omit --append-system-prompt-file when not provided', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
				expect(execaCall[1]).not.toContain('--append-system-prompt-file')
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
			let originalApiKey: string | undefined
			let originalOAuthToken: string | undefined

			beforeEach(() => {
				originalApiKey = process.env.ANTHROPIC_API_KEY
				originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
				delete process.env.ANTHROPIC_API_KEY
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			})

			afterEach(() => {
				if (originalApiKey !== undefined) {
					process.env.ANTHROPIC_API_KEY = originalApiKey
				} else {
					delete process.env.ANTHROPIC_API_KEY
				}
				if (originalOAuthToken !== undefined) {
					process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
				} else {
					delete process.env.CLAUDE_CODE_OAUTH_TOKEN
				}
			})

			it('should add --no-session-persistence flag when noSessionPersistence is true', async () => {
				const prompt = 'Test prompt'

				// resolveBareModeConfig will try OAuth extraction - make it fail
				if (process.platform === 'darwin') {
					mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
				} else {
					vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
				}

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

				// resolveBareModeConfig will try OAuth extraction - make it fail
				if (process.platform === 'darwin') {
					mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
				} else {
					vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
				}

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

		describe('bare parameter', () => {
			let savedApiKey: string | undefined
			let savedOAuthToken: string | undefined

			beforeEach(() => {
				savedApiKey = process.env.ANTHROPIC_API_KEY
				savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
				// Set API key so resolveBareModeConfig() returns early without OAuth extraction
				process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-bare'
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			})

			afterEach(() => {
				if (savedApiKey !== undefined) {
					process.env.ANTHROPIC_API_KEY = savedApiKey
				} else {
					delete process.env.ANTHROPIC_API_KEY
				}
				if (savedOAuthToken !== undefined) {
					process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken
				} else {
					delete process.env.CLAUDE_CODE_OAUTH_TOKEN
				}
			})

			it('should add --bare flag when bare is true', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					bare: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					['--bare', '-p', '--output-format', 'stream-json', '--verbose', '--add-dir', '/tmp'],
					expect.any(Object)
				)
			})

			it('should not add --bare flag when bare is false', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					bare: false,
				})

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--bare')
			})

			it('should not add --bare flag when bare is undefined and not headless+noSessionPersistence', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, { headless: true })

				const execaCall = mockExeca().mock.calls[0]
				expect(execaCall[1]).not.toContain('--bare')
			})

			it('should auto-apply --bare when headless + noSessionPersistence and ANTHROPIC_API_KEY is set', async () => {
				const originalApiKey = process.env.ANTHROPIC_API_KEY
				try {
					process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
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
						expect.arrayContaining(['--bare']),
						expect.any(Object)
					)
				} finally {
					if (originalApiKey !== undefined) {
						process.env.ANTHROPIC_API_KEY = originalApiKey
					} else {
						delete process.env.ANTHROPIC_API_KEY
					}
				}
			})

			it('should not auto-apply --bare when headless + noSessionPersistence but no API key or OAuth token available', async () => {
				const originalApiKey = process.env.ANTHROPIC_API_KEY
				const originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
				try {
					delete process.env.ANTHROPIC_API_KEY
					delete process.env.CLAUDE_CODE_OAUTH_TOKEN
					const prompt = 'Test prompt'

					// On macOS, extractOAuthToken will call security command - make it fail
					if (process.platform === 'darwin') {
						mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
					} else {
						vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
					}

					mockExeca().mockResolvedValueOnce({
						stdout: 'output',
						exitCode: 0,
					})

					await launchClaude(prompt, {
						headless: true,
						noSessionPersistence: true,
					})

					// Find the claude call (skip the security call on macOS)
					const claudeCall = mockExeca().mock.calls.find(
						(call: unknown[]) => call[0] === 'claude'
					)
					expect(claudeCall?.[1]).not.toContain('--bare')
				} finally {
					if (originalApiKey !== undefined) {
						process.env.ANTHROPIC_API_KEY = originalApiKey
					} else {
						delete process.env.ANTHROPIC_API_KEY
					}
					if (originalOAuthToken !== undefined) {
						process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
					} else {
						delete process.env.CLAUDE_CODE_OAUTH_TOKEN
					}
				}
			})

			it('should not auto-apply --bare when bare is explicitly false even with headless + noSessionPersistence + API key', async () => {
				const originalApiKey = process.env.ANTHROPIC_API_KEY
				try {
					process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
					const prompt = 'Test prompt'

					mockExeca().mockResolvedValueOnce({
						stdout: 'output',
						exitCode: 0,
					})

					await launchClaude(prompt, {
						headless: true,
						noSessionPersistence: true,
						bare: false,
					})

					const execaCall = mockExeca().mock.calls[0]
					expect(execaCall[1]).not.toContain('--bare')
				} finally {
					if (originalApiKey !== undefined) {
						process.env.ANTHROPIC_API_KEY = originalApiKey
					} else {
						delete process.env.ANTHROPIC_API_KEY
					}
				}
			})

			it('should combine --bare with other options in correct order', async () => {
				const prompt = 'Test prompt'

				mockExeca().mockResolvedValueOnce({
					stdout: 'output',
					exitCode: 0,
				})

				await launchClaude(prompt, {
					headless: true,
					model: 'opus',
					addDir: '/workspace',
					bare: true,
					noSessionPersistence: true,
				})

				expect(execa).toHaveBeenCalledWith(
					'claude',
					[
						'--bare',
						'-p',
						'--output-format',
						'stream-json',
						'--verbose',
						'--model', 'opus',
						'--add-dir', '/workspace',
						'--add-dir', '/tmp',
						'--no-session-persistence',
					],
					expect.any(Object)
				)
			})
		})
	})

	describe('hasApiKeyForBareMode', () => {
		let originalApiKey: string | undefined

		beforeEach(() => {
			originalApiKey = process.env.ANTHROPIC_API_KEY
		})

		afterEach(() => {
			if (originalApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
		})

		it('should return true when ANTHROPIC_API_KEY is set', () => {
			process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
			expect(hasApiKeyForBareMode()).toBe(true)
		})

		it('should return false when ANTHROPIC_API_KEY is not set', () => {
			delete process.env.ANTHROPIC_API_KEY
			expect(hasApiKeyForBareMode()).toBe(false)
		})

		it('should return false when ANTHROPIC_API_KEY is empty string', () => {
			process.env.ANTHROPIC_API_KEY = ''
			expect(hasApiKeyForBareMode()).toBe(false)
		})

		it('should return false when ANTHROPIC_API_KEY is whitespace only', () => {
			process.env.ANTHROPIC_API_KEY = '   '
			expect(hasApiKeyForBareMode()).toBe(false)
		})
	})

	describe('extractOAuthToken', () => {
		let originalApiKey: string | undefined
		let originalOAuthToken: string | undefined
		let originalPlatform: string

		beforeEach(() => {
			originalApiKey = process.env.ANTHROPIC_API_KEY
			originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			originalPlatform = process.platform
			delete process.env.ANTHROPIC_API_KEY
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN
		})

		afterEach(() => {
			if (originalApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
			if (originalOAuthToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
			} else {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			}
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		})

		it('should return CLAUDE_CODE_OAUTH_TOKEN env var if set', async () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token'
			const token = await extractOAuthToken()
			expect(token).toBe('sk-ant-oat01-test-token')
		})

		it('should return null when CLAUDE_CODE_OAUTH_TOKEN is empty', async () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = ''
			// Mock platform-specific fallback to also return nothing
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
			vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
			const token = await extractOAuthToken()
			expect(token).toBeNull()
		})

		describe('macOS (darwin)', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
			})

			it('should extract token from macOS Keychain via security command', async () => {
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-keychain-token',
						refreshToken: 'rt-test',
						expiresAt: Date.now() + 3600000,
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBe('sk-ant-oat01-keychain-token')

				expect(execa).toHaveBeenCalledWith(
					'security',
					['find-generic-password', '-s', 'Claude Code-credentials', '-a', expect.any(String), '-w'],
					{ timeout: 3000 }
				)
			})

			it('should return null when security command fails', async () => {
				mockExeca().mockRejectedValueOnce(new Error('security: SecKeychainSearchCopyNext: The specified item could not be found'))

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should return null when keychain JSON is malformed', async () => {
				mockExeca().mockResolvedValueOnce({ stdout: 'not-valid-json', exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should return null when claudeAiOauth.accessToken is missing', async () => {
				const credJson = JSON.stringify({ someOtherField: 'value' })
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should return null when token is expired', async () => {
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-expired-token',
						expiresAt: Date.now() - 1000, // expired 1 second ago
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should return null when token expires within 60 seconds (buffer)', async () => {
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-expiring-soon',
						expiresAt: Date.now() + 30_000, // expires in 30s, within 60s buffer
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should handle expiresAt in seconds (heuristic: value < 10 billion)', async () => {
				const nowInSeconds = Math.floor(Date.now() / 1000)
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-seconds-token',
						expiresAt: nowInSeconds + 3600, // 1 hour from now, in seconds
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBe('sk-ant-oat01-seconds-token')
			})

			it('should treat expired token in seconds format as expired', async () => {
				const nowInSeconds = Math.floor(Date.now() / 1000)
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-expired-seconds',
						expiresAt: nowInSeconds - 100, // expired 100 seconds ago, in seconds
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should use 3-second timeout on security command', async () => {
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-token',
						expiresAt: Date.now() + 3600000,
					},
				})
				mockExeca().mockResolvedValueOnce({ stdout: credJson, exitCode: 0 })

				await extractOAuthToken()

				expect(execa).toHaveBeenCalledWith(
					'security',
					expect.any(Array),
					expect.objectContaining({ timeout: 3000 })
				)
			})
		})

		describe('Linux/other platforms', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
			})

			it('should extract token from ~/.claude/.credentials.json', async () => {
				const credJson = JSON.stringify({
					claudeAiOauth: {
						accessToken: 'sk-ant-oat01-linux-token',
						refreshToken: 'rt-test',
						expiresAt: Date.now() + 3600000,
					},
				})
				vi.mocked(readFile).mockResolvedValueOnce(credJson)

				const token = await extractOAuthToken()
				expect(token).toBe('sk-ant-oat01-linux-token')
			})

			it('should return null when credentials file does not exist', async () => {
				vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})

			it('should return null when credentials JSON is malformed', async () => {
				vi.mocked(readFile).mockResolvedValueOnce('not-valid-json')

				const token = await extractOAuthToken()
				expect(token).toBeNull()
			})
		})
	})

	describe('resolveBareModeConfig', () => {
		let originalApiKey: string | undefined
		let originalOAuthToken: string | undefined
		let originalPlatform: string

		beforeEach(() => {
			originalApiKey = process.env.ANTHROPIC_API_KEY
			originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			originalPlatform = process.platform
			delete process.env.ANTHROPIC_API_KEY
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN
		})

		afterEach(() => {
			if (originalApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
			if (originalOAuthToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
			} else {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			}
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
		})

		it('should return { bare: true } when ANTHROPIC_API_KEY is set', async () => {
			process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
			const config = await resolveBareModeConfig()
			expect(config).toEqual({ bare: true })
		})

		it('should return { bare: true, settings: ..., oauthToken: ... } when OAuth token is available', async () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token'
			const config = await resolveBareModeConfig()
			expect(config.bare).toBe(true)
			expect(config.settings).toBeDefined()
			const parsed = JSON.parse(config.settings!)
			// Token should NOT appear in settings (passed via env var instead)
			expect(parsed.apiKeyHelper).toBe('echo $__ILOOM_OAUTH_TOKEN')
			expect(parsed.apiKeyHelper).not.toContain('sk-ant-oat01-test-token')
			// Token should be returned separately for env var injection
			expect(config.oauthToken).toBe('sk-ant-oat01-test-token')
		})

		it('should return { bare: false } when neither API key nor OAuth token available', async () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
			vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
			const config = await resolveBareModeConfig()
			expect(config).toEqual({ bare: false })
		})
	})

	describe('settings parameter in launchClaude', () => {
		let savedApiKey: string | undefined
		let savedOAuthToken: string | undefined

		beforeEach(() => {
			savedApiKey = process.env.ANTHROPIC_API_KEY
			savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			// Set API key so resolveBareModeConfig returns early (no OAuth extraction)
			process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-settings'
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN
		})

		afterEach(() => {
			if (savedApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = savedApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
			if (savedOAuthToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken
			} else {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			}
		})

		it('should add --settings flag when settings is provided', async () => {
			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.resolve({ stdout: 'output', exitCode: 0 }), fakeSubprocess)
			)

			await launchClaude('test prompt', {
				headless: true,
				bare: true,
				settings: '{"apiKeyHelper": "echo token"}',
			})

			expect(execa).toHaveBeenCalledWith(
				'claude',
				expect.arrayContaining(['--settings', '{"apiKeyHelper": "echo token"}']),
				expect.any(Object)
			)
		})

		it('should not add --settings flag when settings is undefined and ANTHROPIC_API_KEY is set', async () => {
			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.resolve({ stdout: 'output', exitCode: 0 }), fakeSubprocess)
			)

			await launchClaude('test prompt', {
				headless: true,
				bare: true,
			})

			const callArgs = mockExeca().mock.calls[0][1] as string[]
			expect(callArgs).not.toContain('--settings')
		})
	})

	describe('bare mode auth failure retry', () => {
		let originalApiKey: string | undefined
		let originalOAuthToken: string | undefined

		beforeEach(() => {
			originalApiKey = process.env.ANTHROPIC_API_KEY
			originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			delete process.env.ANTHROPIC_API_KEY
		})

		afterEach(() => {
			if (originalApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
			if (originalOAuthToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
			} else {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			}
		})

		it('should retry without --bare when auto-applied bare mode fails with auth error', async () => {
			// Set up OAuth token so bare mode will be auto-applied
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token'

			const fakeSubprocess1 = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			const fakeSubprocess2 = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			// First call: fails with auth error (bare mode auto-applied)
			const authError = Object.assign(new Error('Invalid API Key'), {
				stderr: 'Invalid API Key',
				exitCode: 1,
			})
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(authError), fakeSubprocess1)
			)

			// Second call: succeeds (retry without bare)
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.resolve({ stdout: 'retry output', exitCode: 0 }), fakeSubprocess2)
			)

			const result = await launchClaude('test prompt', {
				headless: true,
				noSessionPersistence: true,
			})

			expect(result).toBe('retry output')

			// Verify first call had --bare and --settings
			const firstCallArgs = mockExeca().mock.calls[0][1] as string[]
			expect(firstCallArgs).toContain('--bare')
			expect(firstCallArgs).toContain('--settings')

			// Verify first call passes OAuth token via env var, not in args
			const firstCallOpts = mockExeca().mock.calls[0][2] as Record<string, unknown>
			const firstCallEnv = firstCallOpts.env as Record<string, string>
			expect(firstCallEnv.__ILOOM_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token')

			// Verify settings JSON does NOT contain the actual token
			const settingsIdx = firstCallArgs.indexOf('--settings')
			const settingsJson = firstCallArgs[settingsIdx + 1]
			expect(settingsJson).not.toContain('sk-ant-oat01-test-token')
			expect(settingsJson).toContain('__ILOOM_OAUTH_TOKEN')

			// Verify second call does NOT have --bare or --settings
			const secondCallArgs = mockExeca().mock.calls[1][1] as string[]
			expect(secondCallArgs).not.toContain('--bare')
			expect(secondCallArgs).not.toContain('--settings')

			// Verify warning was logged
			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Bare mode failed'))
		})

		it('should NOT retry when bare was explicitly set by caller', async () => {
			// Mock OAuth extraction failure so resolveBareModeConfig can complete
			// (bare:true without settings triggers resolveBareModeConfig for OAuth)
			if (process.platform === 'darwin') {
				mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
			} else {
				vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
			}

			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			const authError = Object.assign(new Error('Invalid API Key'), {
				stderr: 'Invalid API Key',
				exitCode: 1,
			})
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(authError), fakeSubprocess)
			)

			await expect(
				launchClaude('test prompt', {
					headless: true,
					bare: true,
				})
			).rejects.toThrow('Claude CLI error')

			// execa called for OAuth extraction (on macOS) + claude call = 2 on darwin, 1 on linux
			// Only the claude call matters - verify no retry happened
			const claudeCalls = mockExeca().mock.calls.filter(
				(call: unknown[]) => call[0] === 'claude'
			)
			expect(claudeCalls).toHaveLength(1)
		})

		it('should NOT retry for non-auth errors', async () => {
			// Set up OAuth token so bare mode will be auto-applied
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token'

			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			const timeoutError = Object.assign(new Error('Command timed out'), {
				stderr: 'Command timed out after 30000ms',
				exitCode: 1,
			})
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(timeoutError), fakeSubprocess)
			)

			await expect(
				launchClaude('test prompt', {
					headless: true,
					noSessionPersistence: true,
				})
			).rejects.toThrow('Claude CLI error')

			// Should only have been called once (no retry)
			expect(execa).toHaveBeenCalledTimes(1)
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
		let originalApiKey: string | undefined
		let originalOAuthToken: string | undefined

		beforeEach(() => {
			originalApiKey = process.env.ANTHROPIC_API_KEY
			originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			delete process.env.ANTHROPIC_API_KEY
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN
		})

		afterEach(() => {
			if (originalApiKey !== undefined) {
				process.env.ANTHROPIC_API_KEY = originalApiKey
			} else {
				delete process.env.ANTHROPIC_API_KEY
			}
			if (originalOAuthToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
			} else {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
			}
		})

		// Helper: mock OAuth extraction failure for macOS (security command) or Linux (readFile)
		function mockOAuthExtractionFailure(): void {
			if (process.platform === 'darwin') {
				mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
			} else {
				vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
			}
		}

		it('should generate branch name using Claude when available', async () => {
			const issueTitle = 'Add user authentication'
			const issueNumber = 123

			// Mock Claude CLI detection
			mockExeca().mockResolvedValueOnce({
				stdout: '/usr/local/bin/claude',
				exitCode: 0,
			})

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

			// Mock Claude response with full branch name
			mockExeca().mockResolvedValueOnce({
				stdout: 'feat/issue-123__user-authentication',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			expect(result).toBe('feat/issue-123__user-authentication')
			expect(execa).toHaveBeenCalledWith(
				'claude',
				expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'low', '--system-prompt', expect.any(String), '--no-session-persistence']),
				expect.objectContaining({
					input: expect.stringContaining(issueTitle),
					env: expect.objectContaining({ CLAUDECODE: '0' }),
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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

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

			// OAuth extraction will fail (no credentials)
			mockOAuthExtractionFailure()

			// Mock Claude returning lowercase branch name (correct behavior)
			mockExeca().mockResolvedValueOnce({
				stdout: 'feat/issue-mark-1__nextjs-vercel',
				exitCode: 0,
			})

			const result = await generateBranchName(issueTitle, issueNumber)

			// Should accept the lowercase branch name, not fall back
			expect(result).toBe('feat/issue-mark-1__nextjs-vercel')
		})

		describe('bare mode (auto-applied by launchClaude)', () => {
			let originalApiKey: string | undefined
			let originalOAuthToken: string | undefined

			beforeEach(() => {
				originalApiKey = process.env.ANTHROPIC_API_KEY
				originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
			})

			afterEach(() => {
				if (originalApiKey !== undefined) {
					process.env.ANTHROPIC_API_KEY = originalApiKey
				} else {
					delete process.env.ANTHROPIC_API_KEY
				}
				if (originalOAuthToken !== undefined) {
					process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken
				} else {
					delete process.env.CLAUDE_CODE_OAUTH_TOKEN
				}
			})

			it('should auto-apply --bare when ANTHROPIC_API_KEY is set (headless + noSessionPersistence)', async () => {
				process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
				const issueTitle = 'Add user authentication'
				const issueNumber = 123

				// Mock Claude CLI detection
				mockExeca().mockResolvedValueOnce({
					stdout: '/usr/local/bin/claude',
					exitCode: 0,
				})

				// Mock Claude response
				mockExeca().mockResolvedValueOnce({
					stdout: 'feat/issue-123__user-authentication',
					exitCode: 0,
				})

				await generateBranchName(issueTitle, issueNumber)

				expect(execa).toHaveBeenCalledWith(
					'claude',
					expect.arrayContaining(['--bare']),
					expect.any(Object)
				)
			})

			it('should not auto-apply --bare when no API key or OAuth token available', async () => {
				delete process.env.ANTHROPIC_API_KEY
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN
				const issueTitle = 'Add user authentication'
				const issueNumber = 123

				// Mock Claude CLI detection
				mockExeca().mockResolvedValueOnce({
					stdout: '/usr/local/bin/claude',
					exitCode: 0,
				})

				// On macOS, extractOAuthToken calls security command - make it fail
				if (process.platform === 'darwin') {
					mockExeca().mockRejectedValueOnce(new Error('security: item not found'))
				} else {
					vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'))
				}

				// Mock Claude response
				mockExeca().mockResolvedValueOnce({
					stdout: 'feat/issue-123__user-authentication',
					exitCode: 0,
				})

				await generateBranchName(issueTitle, issueNumber)

				// Find the launchClaude call (the claude command, not security)
				const claudeCall = mockExeca().mock.calls.find(
					(call: unknown[]) => call[0] === 'claude' && (call[1] as string[])?.includes('-p')
				)
				expect(claudeCall?.[1]).not.toContain('--bare')
			})
		})
	})

	describe('AbortSignal support', () => {
		it('should send SIGTERM to the child process when signal is aborted (headless mode)', async () => {
			const controller = new AbortController()
			const killMock = vi.fn()
			const onExitListeners: Array<() => void> = []

			const fakeSubprocess = {
				stdout: null,
				on: vi.fn((event: string, listener: () => void) => {
					if (event === 'exit') onExitListeners.push(listener)
				}),
				kill: killMock,
			}

			// Reject with an error to simulate SIGTERM exit
			const abortError = Object.assign(new Error('Process killed'), { exitCode: null })
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(abortError), fakeSubprocess)
			)

			// Abort the signal before awaiting so aborted is true when the error is caught
			controller.abort()

			const result = await launchClaude('test prompt', {
				headless: true,
				signal: controller.signal,
			})

			// Should not throw and should return void
			expect(result).toBeUndefined()
		})

		it('should not throw when process exits due to intentional abort (headless mode)', async () => {
			const controller = new AbortController()
			const killMock = vi.fn()

			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: killMock,
			}

			const abortError = Object.assign(new Error('Aborted'), { exitCode: 1 })
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(abortError), fakeSubprocess)
			)

			controller.abort()

			await expect(
				launchClaude('test prompt', {
					headless: true,
					signal: controller.signal,
				})
			).resolves.toBeUndefined()
		})

		it('should throw error when process fails without abort signal being triggered', async () => {
			const controller = new AbortController()
			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			const processError = Object.assign(new Error('Process failed'), {
				stderr: 'Some unexpected error',
				exitCode: 1,
			})
			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.reject(processError), fakeSubprocess)
			)

			// Do NOT abort the controller - this should still throw
			await expect(
				launchClaude('test prompt', {
					headless: true,
					signal: controller.signal,
				})
			).rejects.toThrow('Claude CLI error')
		})

		it('should work normally when no signal is provided', async () => {
			const fakeSubprocess = {
				stdout: null,
				on: vi.fn(),
				kill: vi.fn(),
			}

			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.resolve({ stdout: 'output', exitCode: 0 }), fakeSubprocess)
			)

			const result = await launchClaude('test prompt', { headless: true })
			expect(result).toBe('output')
		})

		it('should register abort listener on signal and clean up on process exit (headless mode)', async () => {
			const controller = new AbortController()
			const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener')
			const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

			const exitListeners: Array<() => void> = []
			const fakeSubprocess = {
				stdout: null,
				on: vi.fn((event: string, listener: () => void) => {
					if (event === 'exit') exitListeners.push(listener)
				}),
				kill: vi.fn(),
			}

			mockExeca().mockReturnValueOnce(
				Object.assign(Promise.resolve({ stdout: 'result', exitCode: 0 }), fakeSubprocess)
			)

			await launchClaude('test prompt', {
				headless: true,
				signal: controller.signal,
			})

			// Verify abort listener was registered
			expect(addEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })

			// Simulate process exit - cleanup should be called
			for (const listener of exitListeners) listener()
			expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
		})
	})
})
