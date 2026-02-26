import { describe, it, expect, vi } from 'vitest'
import { buildCommandSequence, escapeSingleQuotes, rgbToHex } from './command-builder.js'

vi.mock('node:fs', () => ({
	existsSync: vi.fn().mockReturnValue(false),
}))

describe('command-builder', () => {
	describe('escapeSingleQuotes', () => {
		it('should escape single quotes', () => {
			expect(escapeSingleQuotes("it's")).toBe("it'\\''s")
		})

		it('should handle strings without single quotes', () => {
			expect(escapeSingleQuotes('hello')).toBe('hello')
		})

		it('should handle multiple single quotes', () => {
			expect(escapeSingleQuotes("it's a 'test'")).toBe("it'\\''s a '\\''test'\\''")
		})
	})

	describe('rgbToHex', () => {
		it('should convert RGB to hex', () => {
			expect(rgbToHex({ r: 255, g: 0, b: 128 })).toBe('#ff0080')
		})

		it('should pad single-digit hex values', () => {
			expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000')
		})

		it('should clamp values to 0-255', () => {
			expect(rgbToHex({ r: 300, g: -10, b: 128 })).toBe('#ff0080')
		})
	})

	describe('buildCommandSequence', () => {
		it('should prefix with space for history suppression', async () => {
			const result = await buildCommandSequence({ command: 'echo hello' })
			expect(result).toBe(' echo hello')
		})

		it('should build cd command for workspace path', async () => {
			const result = await buildCommandSequence({ workspacePath: '/test/path' })
			expect(result).toContain("cd '/test/path'")
		})

		it('should escape single quotes in workspace path', async () => {
			const result = await buildCommandSequence({ workspacePath: "/test/it's" })
			expect(result).toContain("cd '/test/it'\\''s'")
		})

		it('should include port export', async () => {
			const result = await buildCommandSequence({ port: 3000, includePortExport: true })
			expect(result).toContain('export PORT=3000')
		})

		it('should not include port when includePortExport is false', async () => {
			const result = await buildCommandSequence({ port: 3000, includePortExport: false })
			expect(result).not.toContain('export PORT')
		})

		it('should chain commands with &&', async () => {
			const result = await buildCommandSequence({
				workspacePath: '/test',
				command: 'pnpm dev',
				port: 3000,
				includePortExport: true,
			})
			expect(result).toContain(' && ')
			expect(result).toContain("cd '/test'")
			expect(result).toContain('export PORT=3000')
			expect(result).toContain('pnpm dev')
		})

		it('should return space-only for empty options', async () => {
			const result = await buildCommandSequence({})
			expect(result).toBe(' ')
		})
	})
})
