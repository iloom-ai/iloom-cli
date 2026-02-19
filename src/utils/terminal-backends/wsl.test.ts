import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { WSLBackend, escapeForBashC } from './wsl.js'

vi.mock('execa')
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}))
vi.mock('../platform-detect.js', () => ({
	detectWSLDistro: vi.fn(),
}))

import { detectWSLDistro } from '../platform-detect.js'

describe('wsl backend', () => {
	describe('escapeForBashC', () => {
		it('should escape backslashes', () => {
			expect(escapeForBashC('\\path')).toBe('\\\\path')
		})

		it('should escape double quotes', () => {
			expect(escapeForBashC('"hello"')).toBe('\\"hello\\"')
		})

		it('should escape dollar signs', () => {
			expect(escapeForBashC('$PATH')).toBe('\\$PATH')
		})

		it('should escape backticks', () => {
			expect(escapeForBashC('`cmd`')).toBe('\\`cmd\\`')
		})

		it('should escape all special characters together', () => {
			// Parentheses don't need escaping inside double quotes
			expect(escapeForBashC('echo "\\$(`cmd`)\\n"')).toBe(
				'echo \\"\\\\\\$(\\`cmd\\`)\\\\n\\"'
			)
		})
	})

	describe('WSLBackend', () => {
		let backend: WSLBackend
		const originalEnv = { ...process.env }

		beforeEach(() => {
			backend = new WSLBackend()
			process.env = { ...originalEnv }
		})

		afterEach(() => {
			process.env = originalEnv
		})

		describe('openSingle', () => {
			it('should call wt.exe with new-tab and wsl.exe', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					workspacePath: '/home/user/project',
					command: 'pnpm dev',
				})

				expect(execa).toHaveBeenCalledWith('wt.exe', expect.arrayContaining([
					'new-tab',
					'wsl.exe',
					'-d', 'Ubuntu',
					'-e', 'bash', '-lic',
					expect.stringContaining('pnpm dev'),
				]))
			})

			it('should include --title when title is provided', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					title: 'Dev Server',
					command: 'pnpm dev',
				})

				const args = vi.mocked(execa).mock.calls[0][1] as string[]
				expect(args).toContain('--title')
				expect(args).toContain('Dev Server')
			})

			it('should include --tabColor with hex color', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					backgroundColor: { r: 128, g: 77, b: 179 },
					command: 'echo test',
				})

				const args = vi.mocked(execa).mock.calls[0][1] as string[]
				expect(args).toContain('--tabColor')
				expect(args).toContain('#804db3')
			})

			it('should omit -d flag when distro is not available', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue(undefined)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					command: 'echo test',
				})

				const args = vi.mocked(execa).mock.calls[0][1] as string[]
				expect(args).not.toContain('-d')
			})

			it('should throw helpful error when wt.exe is not found', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockRejectedValue(new Error('ENOENT: wt.exe'))

				await expect(backend.openSingle({ command: 'test' })).rejects.toThrow(
					'Windows Terminal (wt.exe) is not available'
				)
			})

			it('should throw generic error for other failures', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockRejectedValue(new Error('Permission denied'))

				await expect(backend.openSingle({ command: 'test' })).rejects.toThrow(
					'Failed to open Windows Terminal tab: Permission denied'
				)
			})
		})

		describe('openMultiple', () => {
			it('should combine multiple tabs with ; separator', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openMultiple([
					{ command: 'cmd1', title: 'Tab 1' },
					{ command: 'cmd2', title: 'Tab 2' },
				])

				expect(execa).toHaveBeenCalledTimes(1)
				const args = vi.mocked(execa).mock.calls[0][1] as string[]

				// Should contain separator between tabs
				expect(args).toContain(';')

				// Should have both tab commands
				const argsStr = args.join(' ')
				expect(argsStr).toContain('Tab 1')
				expect(argsStr).toContain('Tab 2')
			})

			it('should handle three tabs', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openMultiple([
					{ command: 'cmd1', title: 'Tab 1' },
					{ command: 'cmd2', title: 'Tab 2' },
					{ command: 'cmd3', title: 'Tab 3' },
				])

				const args = vi.mocked(execa).mock.calls[0][1] as string[]
				// Should have 2 separators for 3 tabs
				const separators = args.filter(a => a === ';')
				expect(separators).toHaveLength(2)
			})

			it('should throw error for undefined options', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')

				const arr = [{ command: 'cmd1' }]
				// @ts-expect-error intentionally testing undefined
				arr.push(undefined)

				await expect(backend.openMultiple(arr)).rejects.toThrow(
					'Terminal option at index 1 is undefined'
				)
			})

			it('should throw helpful error when wt.exe is not found', async () => {
				vi.mocked(detectWSLDistro).mockReturnValue('Ubuntu')
				vi.mocked(execa).mockRejectedValue(new Error('ENOENT'))

				await expect(
					backend.openMultiple([
						{ command: 'cmd1' },
						{ command: 'cmd2' },
					])
				).rejects.toThrow('Windows Terminal (wt.exe) is not available')
			})
		})
	})
})
