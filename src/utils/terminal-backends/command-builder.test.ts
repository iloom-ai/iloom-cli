import { describe, it, expect, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { buildCommandSequence, escapeSingleQuotes, rgbToHex } from './command-builder.js'

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}))

describe('command-builder', () => {
	describe('buildCommandSequence', () => {
		it('should build cd command for workspace path', async () => {
			const result = await buildCommandSequence({
				workspacePath: '/home/user/project',
			})
			expect(result).toBe(" cd '/home/user/project'")
		})

		it('should chain multiple commands with &&', async () => {
			const result = await buildCommandSequence({
				workspacePath: '/home/user/project',
				command: 'pnpm dev',
				port: 3042,
				includePortExport: true,
			})
			expect(result).toBe(" cd '/home/user/project' && export PORT=3042 && pnpm dev")
		})

		it('should include env source commands when requested', async () => {
			vi.mocked(existsSync).mockImplementation((path) => {
				const p = String(path)
				return p.endsWith('.env') || p.endsWith('.env.local')
			})

			const result = await buildCommandSequence({
				workspacePath: '/home/user/project',
				includeEnvSetup: true,
			})
			expect(result).toContain('source .env')
			expect(result).toContain('source .env.local')
		})

		it('should prefix with space for history suppression', async () => {
			const result = await buildCommandSequence({
				command: 'echo hello',
			})
			expect(result).toMatch(/^ /)
		})

		it('should handle empty options', async () => {
			const result = await buildCommandSequence({})
			expect(result).toBe(' ')
		})

		it('should not export PORT when includePortExport is false', async () => {
			const result = await buildCommandSequence({
				port: 3042,
				includePortExport: false,
			})
			expect(result).not.toContain('PORT')
		})

		it('should escape single quotes in workspace path', async () => {
			const result = await buildCommandSequence({
				workspacePath: "/home/user/project's",
			})
			expect(result).toContain("cd '/home/user/project'\\''s'")
		})
	})

	describe('escapeSingleQuotes', () => {
		it('should escape single quotes', () => {
			expect(escapeSingleQuotes("it's")).toBe("it'\\''s")
		})

		it('should handle no quotes', () => {
			expect(escapeSingleQuotes('hello')).toBe('hello')
		})

		it('should handle multiple quotes', () => {
			expect(escapeSingleQuotes("it's a 'test'")).toBe("it'\\''s a '\\''test'\\''")
		})
	})

	describe('rgbToHex', () => {
		it('should convert RGB to hex', () => {
			expect(rgbToHex({ r: 128, g: 77, b: 179 })).toBe('#804db3')
		})

		it('should handle black', () => {
			expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
		})

		it('should handle white', () => {
			expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe('#ffffff')
		})

		it('should clamp values above 255', () => {
			expect(rgbToHex({ r: 300, g: 256, b: 999 })).toBe('#ffffff')
		})

		it('should clamp values below 0', () => {
			expect(rgbToHex({ r: -1, g: -50, b: -100 })).toBe('#000000')
		})
	})
})
