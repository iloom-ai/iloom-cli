import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import fs from 'fs-extra'
import { prepareSystemPromptForPlatform } from './system-prompt-writer.js'

vi.mock('fs-extra')

const mockFs = vi.mocked(fs)

describe('system-prompt-writer', () => {
	describe('prepareSystemPromptForPlatform', () => {
		const systemPrompt = 'You are a helpful assistant.\nFollow these instructions.'
		const workspacePath = '/home/user/project'

		it('should write prompt to file and return appendSystemPromptFile path', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			const claudeDir = path.join(workspacePath, '.claude')
			const promptFilePath = path.join(claudeDir, 'iloom-system-prompt.md')

			// Should create .claude directory
			expect(mockFs.ensureDir).toHaveBeenCalledWith(claudeDir)

			// Should write prompt to file
			expect(mockFs.writeFile).toHaveBeenCalledWith(promptFilePath, systemPrompt, 'utf-8')

			// Should return file path
			expect(result).toEqual({ appendSystemPromptFile: promptFilePath })
		})

		it('should NOT return appendSystemPrompt, pluginDir, or initialPromptOverride', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			expect(result).not.toHaveProperty('appendSystemPrompt')
			expect(result).not.toHaveProperty('pluginDir')
			expect(result).not.toHaveProperty('initialPromptOverride')
		})

		it('should work identically regardless of platform', async () => {
			// The function no longer accepts a platform parameter - it always writes to file.
			// Run it twice to confirm consistent behavior.
			const result1 = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)
			const result2 = await prepareSystemPromptForPlatform(systemPrompt, '/other/workspace')

			expect(result1.appendSystemPromptFile).toBe(
				path.join(workspacePath, '.claude', 'iloom-system-prompt.md'),
			)
			expect(result2.appendSystemPromptFile).toBe(
				path.join('/other/workspace', '.claude', 'iloom-system-prompt.md'),
			)
		})

		it('should ensure .claude directory exists before writing', async () => {
			await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			// ensureDir should be called before writeFile
			const ensureDirOrder = mockFs.ensureDir.mock.invocationCallOrder[0]
			const writeFileOrder = mockFs.writeFile.mock.invocationCallOrder[0]
			expect(ensureDirOrder).toBeLessThan(writeFileOrder!)
		})
	})
})
