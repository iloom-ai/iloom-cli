import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import fs from 'fs-extra'
import { prepareSystemPromptForPlatform } from './system-prompt-writer.js'

vi.mock('fs-extra')

const mockFs = vi.mocked(fs)

function expectedPromptFilePath(workspacePath: string): string {
	const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12)
	return path.join(os.tmpdir(), `iloom-system-prompt-${hash}.md`)
}

describe('system-prompt-writer', () => {
	describe('prepareSystemPromptForPlatform', () => {
		const systemPrompt = 'You are a helpful assistant.\nFollow these instructions.'
		const workspacePath = '/home/user/project'

		it('should write prompt to temp file and return appendSystemPromptFile path', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			const promptFilePath = expectedPromptFilePath(workspacePath)

			// Should NOT create .claude directory inside workspace
			expect(mockFs.ensureDir).not.toHaveBeenCalled()

			// Should write prompt to temp file
			expect(mockFs.writeFile).toHaveBeenCalledWith(promptFilePath, systemPrompt, 'utf-8')

			// Should return file path
			expect(result).toEqual({ appendSystemPromptFile: promptFilePath })
		})

		it('should write to os.tmpdir(), not inside the workspace', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			expect(result.appendSystemPromptFile).toContain(os.tmpdir())
			expect(result.appendSystemPromptFile).not.toContain(workspacePath)
		})

		it('should NOT return appendSystemPrompt, pluginDir, or initialPromptOverride', async () => {
			const result = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			expect(result).not.toHaveProperty('appendSystemPrompt')
			expect(result).not.toHaveProperty('pluginDir')
			expect(result).not.toHaveProperty('initialPromptOverride')
		})

		it('should produce different file paths for different workspace paths', async () => {
			const result1 = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)
			const result2 = await prepareSystemPromptForPlatform(systemPrompt, '/other/workspace')

			expect(result1.appendSystemPromptFile).toBe(expectedPromptFilePath(workspacePath))
			expect(result2.appendSystemPromptFile).toBe(expectedPromptFilePath('/other/workspace'))
			expect(result1.appendSystemPromptFile).not.toBe(result2.appendSystemPromptFile)
		})

		it('should produce the same file path for the same workspace path', async () => {
			const result1 = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)
			const result2 = await prepareSystemPromptForPlatform(systemPrompt, workspacePath)

			expect(result1.appendSystemPromptFile).toBe(result2.appendSystemPromptFile)
		})
	})
})
