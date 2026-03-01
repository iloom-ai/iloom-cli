import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import fs from 'fs-extra'
import { prepareSystemPromptForPlatform, createSessionStartPlugin } from './system-prompt-writer.js'

vi.mock('fs-extra')

const mockFs = vi.mocked(fs)

describe('system-prompt-writer', () => {
	describe('prepareSystemPromptForPlatform', () => {
		const systemPrompt = 'You are a helpful assistant.\nFollow these instructions.'
		const workspacePath = '/home/user/project'

		it('should return inline appendSystemPrompt on darwin', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'darwin')

			expect(result).toEqual({ appendSystemPrompt: systemPrompt })
			expect(mockFs.ensureDir).not.toHaveBeenCalled()
			expect(mockFs.writeFile).not.toHaveBeenCalled()
		})

		it('should return inline appendSystemPrompt on linux', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'linux')

			expect(result).toEqual({ appendSystemPrompt: systemPrompt })
			expect(mockFs.ensureDir).not.toHaveBeenCalled()
			expect(mockFs.writeFile).not.toHaveBeenCalled()
		})

		it('should write prompt file and return plugin config on win32', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'win32')

			const claudeDir = path.join(workspacePath, '.claude')
			const promptFilePath = path.join(claudeDir, 'iloom-system-prompt.md')
			const pluginDir = path.join(claudeDir, 'iloom-plugin')

			// Should create .claude directory and write prompt file
			expect(mockFs.ensureDir).toHaveBeenCalledWith(claudeDir)
			expect(mockFs.writeFile).toHaveBeenCalledWith(promptFilePath, systemPrompt, 'utf-8')

			// Should create plugin directory with hooks.json
			expect(mockFs.ensureDir).toHaveBeenCalledWith(pluginDir)

			// Should return plugin config with /clear override
			expect(result).toEqual({
				pluginDir,
				initialPromptOverride: '/clear',
			})
		})

		it('should not include appendSystemPrompt in win32 result', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'win32')

			expect(result.appendSystemPrompt).toBeUndefined()
		})

		it('should not include pluginDir or initialPromptOverride for darwin', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'darwin')

			expect(result.pluginDir).toBeUndefined()
			expect(result.initialPromptOverride).toBeUndefined()
		})

		it('should not include pluginDir or initialPromptOverride for linux', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'linux')

			expect(result.pluginDir).toBeUndefined()
			expect(result.initialPromptOverride).toBeUndefined()
		})

		it('should treat unknown platforms like win32 (non-darwin, non-linux)', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath, 'freebsd')

			// Should fall through to Windows-style file-based approach
			expect(result.pluginDir).toBeDefined()
			expect(result.initialPromptOverride).toBe('/clear')
			expect(result.appendSystemPrompt).toBeUndefined()
		})

		it('should default to process.platform when no platform argument given', async () => {
			// On macOS (where tests run), this should return inline prompt
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			// process.platform is 'darwin' in test environment
			expect(result.appendSystemPrompt).toBe(systemPrompt)
		})
	})

	describe('createSessionStartPlugin', () => {
		it('should write runner.js and hooks.json with node command for system prompt file', async () => {
			const pluginDir = '/workspace/.claude/iloom-plugin'
			const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'

			await createSessionStartPlugin(pluginDir, promptFilePath)

			// Should create plugin directory
			expect(mockFs.ensureDir).toHaveBeenCalledWith(pluginDir)

			// Should write runner.js with JSON-safe embedded path
			const runnerCall = mockFs.writeFile.mock.calls.find(
				(call) => typeof call[0] === 'string' && call[0].endsWith('runner.js'),
			)
			expect(runnerCall).toBeDefined()
			const runnerContent = runnerCall![1] as string
			expect(runnerContent).toBe(
				`process.stdout.write(require('fs').readFileSync(${JSON.stringify(promptFilePath)}, 'utf-8'));`
			)

			// Should write hooks.json that invokes runner.js
			const hooksCall = mockFs.writeFile.mock.calls.find(
				(call) => typeof call[0] === 'string' && call[0].endsWith('hooks.json'),
			)
			expect(hooksCall).toBeDefined()
			const writtenJson = JSON.parse(hooksCall![1] as string)

			const runnerPath = path.join(pluginDir, 'runner.js').replace(/\\/g, '/')
			expect(writtenJson).toEqual({
				hooks: {
					SessionStart: [
						{
							matcher: '*',
							hooks: [
								{
									type: 'command',
									command: `node "${runnerPath}"`,
								},
							],
						},
					],
				},
			})
		})

		it('should normalize Windows backslashes in runner.js path used by hooks.json', async () => {
			const pluginDir = 'C:/Users/dev/.claude/iloom-plugin'
			const promptFilePath = 'C:\\Users\\dev\\.claude\\iloom-system-prompt.md'

			await createSessionStartPlugin(pluginDir, promptFilePath)

			// runner.js should embed the path via JSON.stringify (handles backslashes safely)
			const runnerCall = mockFs.writeFile.mock.calls.find(
				(call) => typeof call[0] === 'string' && call[0].endsWith('runner.js'),
			)
			expect(runnerCall).toBeDefined()
			const runnerContent = runnerCall![1] as string
			// JSON.stringify preserves the backslashes as escaped sequences
			expect(runnerContent).toBe(
				`process.stdout.write(require('fs').readFileSync(${JSON.stringify(promptFilePath)}, 'utf-8'));`
			)

			// hooks.json command should reference runner.js with forward slashes
			const hooksCall = mockFs.writeFile.mock.calls.find(
				(call) => typeof call[0] === 'string' && call[0].endsWith('hooks.json'),
			)
			expect(hooksCall).toBeDefined()
			const writtenJson = JSON.parse(hooksCall![1] as string)
			const command = writtenJson.hooks.SessionStart[0].hooks[0].command
			expect(command).not.toContain('\\')
			expect(command).toContain('runner.js')
		})

		it('should create plugin directory structure with runner.js and hooks.json', async () => {
			const pluginDir = '/workspace/.claude/iloom-plugin'
			const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'

			await createSessionStartPlugin(pluginDir, promptFilePath)

			expect(mockFs.ensureDir).toHaveBeenCalledWith(pluginDir)
			// Should write both runner.js and hooks.json
			expect(mockFs.writeFile).toHaveBeenCalledTimes(2)
		})

		it('should use runner.js instead of node -e or cat for cross-platform safety', async () => {
			const pluginDir = '/workspace/.claude/iloom-plugin'
			const promptFilePath = '/workspace/.claude/iloom-system-prompt.md'

			await createSessionStartPlugin(pluginDir, promptFilePath)

			const hooksCall = mockFs.writeFile.mock.calls.find(
				(call) => typeof call[0] === 'string' && call[0].endsWith('hooks.json'),
			)
			const writtenJson = JSON.parse(hooksCall![1] as string)
			const command = writtenJson.hooks.SessionStart[0].hooks[0].command

			// Should use runner.js file, not inline node -e or cat
			expect(command).toMatch(/^node ".*runner\.js"$/)
			expect(command).not.toContain('-e')
			expect(command).not.toMatch(/^cat /)
		})
	})
})
