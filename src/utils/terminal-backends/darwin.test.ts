import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { DarwinBackend, detectITerm2, escapeForAppleScript, escapePathForAppleScript } from './darwin.js'

vi.mock('execa')
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}))

describe('darwin backend', () => {
	describe('detectITerm2', () => {
		it('should return true when iTerm.app exists', () => {
			vi.mocked(existsSync).mockReturnValue(true)
			expect(detectITerm2()).toBe(true)
		})

		it('should return false when iTerm.app does not exist', () => {
			vi.mocked(existsSync).mockReturnValue(false)
			expect(detectITerm2()).toBe(false)
		})
	})

	describe('escapeForAppleScript', () => {
		it('should escape backslashes', () => {
			expect(escapeForAppleScript('\\path')).toBe('\\\\path')
		})

		it('should escape double quotes', () => {
			expect(escapeForAppleScript('"hello"')).toBe('\\"hello\\"')
		})

		it('should escape both backslashes and quotes', () => {
			expect(escapeForAppleScript('echo "\\$PATH"')).toBe('echo \\"\\\\$PATH\\"')
		})
	})

	describe('escapePathForAppleScript', () => {
		it('should escape single quotes', () => {
			expect(escapePathForAppleScript("/user's/path")).toBe("/user'\\''s/path")
		})

		it('should handle no quotes', () => {
			expect(escapePathForAppleScript('/home/user/project')).toBe('/home/user/project')
		})
	})

	describe('DarwinBackend', () => {
		const originalPlatform = process.platform
		let backend: DarwinBackend

		beforeEach(() => {
			backend = new DarwinBackend()
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
		})

		afterEach(() => {
			Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true })
		})

		describe('openSingle', () => {
			it('should use Terminal.app when iTerm2 is not available', async () => {
				vi.mocked(existsSync).mockReturnValue(false)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					workspacePath: '/Users/test/workspace',
					command: 'pnpm dev',
				})

				expect(execa).toHaveBeenCalledTimes(2)
				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('tell application "Terminal"')
				expect(applescript).toContain('pnpm dev')
			})

			it('should use iTerm2 when available', async () => {
				vi.mocked(existsSync).mockReturnValue(true)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					workspacePath: '/Users/test/workspace',
					command: 'pnpm dev',
				})

				expect(execa).toHaveBeenCalledTimes(1)
				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('tell application id "com.googlecode.iterm2"')
			})

			it('should apply background color in Terminal.app', async () => {
				vi.mocked(existsSync).mockReturnValue(false)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					backgroundColor: { r: 128, g: 77, b: 179 },
				})

				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('set background color of newTab to {32896, 19789, 46003}')
			})

			it('should apply background color in iTerm2', async () => {
				vi.mocked(existsSync).mockReturnValue(true)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					backgroundColor: { r: 128, g: 77, b: 179 },
				})

				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('set background color of s1 to {32896, 19789, 46003}')
			})

			it('should set tab title in iTerm2', async () => {
				vi.mocked(existsSync).mockReturnValue(true)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openSingle({
					title: 'Dev Server - Issue #42',
				})

				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('set name of s1 to "Dev Server - Issue #42"')
			})

			it('should throw on osascript failure', async () => {
				vi.mocked(existsSync).mockReturnValue(false)
				vi.mocked(execa).mockRejectedValue(new Error('AppleScript failed'))

				await expect(backend.openSingle({})).rejects.toThrow(
					'Failed to open terminal window: AppleScript failed'
				)
			})
		})

		describe('openMultiple', () => {
			it('should use iTerm2 multi-tab script when iTerm2 is available', async () => {
				vi.mocked(existsSync).mockReturnValue(true)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openMultiple([
					{ workspacePath: '/test/1', command: 'cmd1' },
					{ workspacePath: '/test/2', command: 'cmd2' },
				])

				expect(execa).toHaveBeenCalledTimes(1)
				const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
				expect(applescript).toContain('create window with default profile')
				expect(applescript).toContain('create tab with default profile')
				expect(applescript).toContain('cmd1')
				expect(applescript).toContain('cmd2')
			})

			it('should fall back to multiple Terminal.app windows', async () => {
				vi.mocked(existsSync).mockReturnValue(false)
				vi.mocked(execa).mockResolvedValue({} as never)

				await backend.openMultiple([
					{ workspacePath: '/test/1', command: 'cmd1' },
					{ workspacePath: '/test/2', command: 'cmd2' },
				])

				// Each Terminal.app window = 2 execa calls (script + activate)
				expect(execa).toHaveBeenCalledTimes(4)
			})
		})
	})
})
