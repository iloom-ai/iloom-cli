import { describe, it, expect, vi } from 'vitest'
import { executeClaudeP, parseStreamJsonResult } from './claude-executor-server.js'

vi.mock('execa')

// Import execa after mocking so we can control its behavior
import { execa } from 'execa'
const mockExeca = vi.mocked(execa)

describe('parseStreamJsonResult', () => {
	it('extracts result from stream-json output with single result line', () => {
		const output = [
			'{"type":"progress","data":"thinking..."}',
			'{"type":"result","result":"The answer is 42"}',
		].join('\n')

		expect(parseStreamJsonResult(output)).toBe('The answer is 42')
	})

	it('extracts result from last result line when multiple exist', () => {
		const output = [
			'{"type":"result","result":"First result"}',
			'{"type":"progress","data":"more work..."}',
			'{"type":"result","result":"Final result"}',
		].join('\n')

		expect(parseStreamJsonResult(output)).toBe('Final result')
	})

	it('returns empty string when no result line found', () => {
		const output = [
			'{"type":"progress","data":"thinking..."}',
			'{"type":"progress","data":"still thinking..."}',
		].join('\n')

		expect(parseStreamJsonResult(output)).toBe('')
	})

	it('handles malformed JSON lines gracefully', () => {
		const output = [
			'not valid json',
			'{"type":"result","result":"Valid result"}',
			'also not json {{{',
		].join('\n')

		expect(parseStreamJsonResult(output)).toBe('Valid result')
	})

	it('handles empty output', () => {
		expect(parseStreamJsonResult('')).toBe('')
	})

	it('handles output with only whitespace lines', () => {
		expect(parseStreamJsonResult('  \n  \n  ')).toBe('')
	})

	it('handles JSON objects without type field', () => {
		const output = '{"result":"no type field"}'
		expect(parseStreamJsonResult(output)).toBe('')
	})

	it('handles JSON objects with type result but no result field', () => {
		const output = '{"type":"result","data":"missing result key"}'
		expect(parseStreamJsonResult(output)).toBe('')
	})

	it('converts non-string result values to string', () => {
		const output = '{"type":"result","result":123}'
		expect(parseStreamJsonResult(output)).toBe('123')
	})
})

describe('executeClaudeP', () => {
	it('spawns claude -p with correct args for basic invocation', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"hello"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({ prompt: 'Say hello' })

		expect(mockExeca).toHaveBeenCalledWith(
			'claude',
			expect.arrayContaining([
				'-p',
				'--output-format',
				'stream-json',
				'--verbose',
				'--permission-mode',
				'bypassPermissions',
				'--max-turns',
				'200',
			]),
			expect.objectContaining({
				input: 'Say hello',
				timeout: 600_000,
			})
		)
	})

	it('strips CLAUDECODE from env and sets required env vars', async () => {
		// Set CLAUDECODE in process.env to verify it gets stripped
		const originalClaudecode = process.env.CLAUDECODE
		process.env.CLAUDECODE = '1'

		try {
			mockExeca.mockResolvedValue({
				stdout: '{"type":"result","result":"ok"}',
				stderr: '',
				exitCode: 0,
			} as never)

			await executeClaudeP({ prompt: 'test' })

			const callArgs = mockExeca.mock.calls[0]!
			const options = callArgs[2] as { env: Record<string, string | undefined> }

			expect(options.env.CLAUDECODE).toBeUndefined()
			expect(options.env.ENABLE_TOOL_SEARCH).toBe('auto:30')
			expect(options.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING).toBe('1')
			expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
			expect(options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
			expect(options.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium')
		} finally {
			if (originalClaudecode === undefined) {
				delete process.env.CLAUDECODE
			} else {
				process.env.CLAUDECODE = originalClaudecode
			}
		}
	})

	it('includes --model flag when model is provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({ prompt: 'test', model: 'sonnet' })

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const modelIdx = args.indexOf('--model')
		expect(modelIdx).toBeGreaterThan(-1)
		expect(args[modelIdx + 1]).toBe('sonnet')
	})

	it('includes --allowed-tools when tools string is provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			allowedTools: 'Bash,Read,Edit',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const toolsIdx = args.indexOf('--allowed-tools')
		expect(toolsIdx).toBeGreaterThan(-1)
		expect(args[toolsIdx + 1]).toBe('Bash')
		expect(args[toolsIdx + 2]).toBe('Read')
		expect(args[toolsIdx + 3]).toBe('Edit')
	})

	it('includes --mcp-config when mcpConfigPath is provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			mcpConfigPath: '/path/to/mcp-config.json',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const configIdx = args.indexOf('--mcp-config')
		expect(configIdx).toBeGreaterThan(-1)
		expect(args[configIdx + 1]).toBe('/path/to/mcp-config.json')
	})

	it('returns structured success result with extracted text', async () => {
		mockExeca.mockResolvedValue({
			stdout: [
				'{"type":"progress","data":"working..."}',
				'{"type":"result","result":"Implementation complete"}',
			].join('\n'),
			stderr: '',
			exitCode: 0,
		} as never)

		const result = await executeClaudeP({ prompt: 'Implement feature' })

		expect(result).toEqual({
			success: true,
			result: 'Implementation complete',
			exitCode: 0,
			error: null,
		})
	})

	it('returns structured error result on non-zero exit code', async () => {
		const error = new Error('Process failed') as Error & {
			exitCode: number
			timedOut: boolean
			stdout: string
			stderr: string
		}
		error.exitCode = 1
		error.timedOut = false
		error.stdout = ''
		error.stderr = 'Something went wrong'

		mockExeca.mockRejectedValue(error)

		const result = await executeClaudeP({ prompt: 'test' })

		expect(result).toEqual({
			success: false,
			result: '',
			exitCode: 1,
			error: 'Something went wrong',
		})
	})

	it('returns structured error result on timeout', async () => {
		const error = new Error('Timed out') as Error & {
			exitCode: number
			timedOut: boolean
			stdout: string
			stderr: string
		}
		error.exitCode = 1
		error.timedOut = true
		error.stdout = ''
		error.stderr = ''

		mockExeca.mockRejectedValue(error)

		const result = await executeClaudeP({ prompt: 'test', timeoutMs: 5000 })

		expect(result).toEqual({
			success: false,
			result: '',
			exitCode: 1,
			error: 'Process timed out after 5000ms',
		})
	})

	it('sets cwd to provided workingDirectory', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			workingDirectory: '/tmp/my-worktree',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const options = callArgs[2] as { cwd?: string }
		expect(options.cwd).toBe('/tmp/my-worktree')
	})

	it('does not set cwd when workingDirectory is not provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({ prompt: 'test' })

		const callArgs = mockExeca.mock.calls[0]!
		const options = callArgs[2] as { cwd?: string }
		expect(options.cwd).toBeUndefined()
	})

	it('includes --max-turns flag with custom value', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({ prompt: 'test', maxTurns: 50 })

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const turnsIdx = args.indexOf('--max-turns')
		expect(turnsIdx).toBeGreaterThan(-1)
		expect(args[turnsIdx + 1]).toBe('50')
	})

	it('includes --system-prompt-file flag when provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			systemPromptFile: '/path/to/agent.md',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const fileIdx = args.indexOf('--system-prompt-file')
		expect(fileIdx).toBeGreaterThan(-1)
		expect(args[fileIdx + 1]).toBe('/path/to/agent.md')
	})

	it('extracts partial result from stdout on error', async () => {
		const error = new Error('Process failed') as Error & {
			exitCode: number
			timedOut: boolean
			stdout: string
			stderr: string
		}
		error.exitCode = 1
		error.timedOut = false
		error.stdout = [
			'{"type":"progress","data":"started"}',
			'{"type":"result","result":"Partial work done"}',
		].join('\n')
		error.stderr = 'Some error occurred'

		mockExeca.mockRejectedValue(error)

		const result = await executeClaudeP({ prompt: 'test' })

		expect(result.success).toBe(false)
		expect(result.result).toBe('Partial work done')
		expect(result.error).toBe('Some error occurred')
	})

	it('falls back to error message when stderr is empty', async () => {
		const error = new Error('ENOENT: command not found') as Error & {
			exitCode: number
			timedOut: boolean
			stdout: string
			stderr: string
		}
		error.exitCode = 127
		error.timedOut = false
		error.stdout = ''
		error.stderr = ''

		mockExeca.mockRejectedValue(error)

		const result = await executeClaudeP({ prompt: 'test' })

		expect(result.success).toBe(false)
		expect(result.exitCode).toBe(127)
		expect(result.error).toBe('ENOENT: command not found')
	})

	it('uses default timeout and maxTurns when not provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({ prompt: 'test' })

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const options = callArgs[2] as { timeout: number }

		// Default timeout
		expect(options.timeout).toBe(600_000)

		// Default maxTurns
		const turnsIdx = args.indexOf('--max-turns')
		expect(args[turnsIdx + 1]).toBe('200')
	})

	it('handles allowedTools with whitespace gracefully', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			allowedTools: ' Bash , Read , Edit ',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		const toolsIdx = args.indexOf('--allowed-tools')
		expect(args[toolsIdx + 1]).toBe('Bash')
		expect(args[toolsIdx + 2]).toBe('Read')
		expect(args[toolsIdx + 3]).toBe('Edit')
	})

	it('skips --allowed-tools when empty string is provided', async () => {
		mockExeca.mockResolvedValue({
			stdout: '{"type":"result","result":"ok"}',
			stderr: '',
			exitCode: 0,
		} as never)

		await executeClaudeP({
			prompt: 'test',
			allowedTools: '',
		})

		const callArgs = mockExeca.mock.calls[0]!
		const args = callArgs[1] as string[]
		expect(args).not.toContain('--allowed-tools')
	})
})
