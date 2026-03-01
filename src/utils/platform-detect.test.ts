import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isWSL, detectTerminalEnvironment, detectWSLDistro, _resetWSLCache } from './platform-detect.js'

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(),
}))

import { readFileSync } from 'node:fs'

describe('platform-detect', () => {
	const originalPlatform = process.platform
	const originalEnv = { ...process.env }

	beforeEach(() => {
		vi.clearAllMocks()
		_resetWSLCache()
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true })
		process.env = originalEnv
	})

	describe('isWSL', () => {
		it('should return false on non-linux platforms', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
			expect(isWSL()).toBe(false)
		})

		it('should return true when WSL_DISTRO_NAME is set', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			process.env.WSL_DISTRO_NAME = 'Ubuntu'
			expect(isWSL()).toBe(true)
		})

		it('should fall back to /proc/version check', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue('Linux version 5.15.0 (microsoft-standard-WSL2)')
			expect(isWSL()).toBe(true)
		})

		it('should return false when not WSL', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue('Linux version 6.8.0-90-generic')
			expect(isWSL()).toBe(false)
		})

		it('should return false when /proc/version is not found (ENOENT)', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
			err.code = 'ENOENT'
			vi.mocked(readFileSync).mockImplementation(() => { throw err })
			expect(isWSL()).toBe(false)
		})

		it('should return false when /proc/version throws an unexpected error', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockImplementation(() => { throw new Error('unexpected failure') })
			expect(isWSL()).toBe(false)
		})

		it('should cache the result', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue('Linux version 6.8.0-90-generic')

			isWSL()
			isWSL()

			expect(readFileSync).toHaveBeenCalledTimes(1)
		})
	})

	describe('detectTerminalEnvironment', () => {
		it('should return darwin on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
			expect(detectTerminalEnvironment()).toBe('darwin')
		})

		it('should return win32 on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', writable: true })
			expect(detectTerminalEnvironment()).toBe('win32')
		})

		it('should return wsl on WSL', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			process.env.WSL_DISTRO_NAME = 'Ubuntu'
			expect(detectTerminalEnvironment()).toBe('wsl')
		})

		it('should return linux on native Linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue('Linux version 6.8.0-90-generic')
			expect(detectTerminalEnvironment()).toBe('linux')
		})

		it('should return unsupported for unknown platforms', () => {
			Object.defineProperty(process, 'platform', { value: 'freebsd', writable: true })
			expect(detectTerminalEnvironment()).toBe('unsupported')
		})
	})

	describe('detectWSLDistro', () => {
		it('should return the distro name from env', () => {
			process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04'
			expect(detectWSLDistro()).toBe('Ubuntu-22.04')
		})

		it('should return undefined when not set', () => {
			delete process.env.WSL_DISTRO_NAME
			expect(detectWSLDistro()).toBeUndefined()
		})

		it('should return undefined for empty string', () => {
			process.env.WSL_DISTRO_NAME = ''
			expect(detectWSLDistro()).toBeUndefined()
		})
	})
})
