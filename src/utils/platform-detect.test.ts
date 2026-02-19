import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { execa } from 'execa'
import {
	isWSL,
	detectTerminalEnvironment,
	detectWSLDistro,
	isWindowsTerminalAvailable,
	_resetWSLCache,
} from './platform-detect.js'

vi.mock('node:fs', () => ({
	readFileSync: vi.fn(),
}))

vi.mock('execa')

describe('platform-detect', () => {
	const originalPlatform = process.platform
	const originalEnv = { ...process.env }

	beforeEach(() => {
		_resetWSLCache()
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		})
		process.env = originalEnv
	})

	describe('isWSL', () => {
		it('should return false on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
			delete process.env.WSL_DISTRO_NAME

			expect(isWSL()).toBe(false)
		})

		it('should return false on native Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', writable: true })
			delete process.env.WSL_DISTRO_NAME

			expect(isWSL()).toBe(false)
		})

		it('should return true when WSL_DISTRO_NAME is set on Linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			process.env.WSL_DISTRO_NAME = 'Ubuntu'

			expect(isWSL()).toBe(true)
		})

		it('should return true when /proc/version contains "microsoft"', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue(
				'Linux version 5.15.167.4-microsoft-standard-WSL2 (gcc)'
			)

			expect(isWSL()).toBe(true)
		})

		it('should return true when /proc/version contains "WSL"', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue(
				'Linux version 5.15.0 WSL2 (gcc version 12)'
			)

			expect(isWSL()).toBe(true)
		})

		it('should return false on native Linux without WSL signatures', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue(
				'Linux version 6.1.0-generic (gcc version 12)'
			)

			expect(isWSL()).toBe(false)
		})

		it('should return false when /proc/version cannot be read', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockImplementation(() => {
				throw new Error('ENOENT')
			})

			expect(isWSL()).toBe(false)
		})

		it('should cache the result', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			process.env.WSL_DISTRO_NAME = 'Ubuntu'

			expect(isWSL()).toBe(true)

			// Even if we change the env, cached result should be returned
			delete process.env.WSL_DISTRO_NAME
			expect(isWSL()).toBe(true)
		})
	})

	describe('detectTerminalEnvironment', () => {
		it('should return "darwin" on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', writable: true })
			expect(detectTerminalEnvironment()).toBe('darwin')
		})

		it('should return "win32" on native Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', writable: true })
			expect(detectTerminalEnvironment()).toBe('win32')
		})

		it('should return "wsl" on WSL', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			process.env.WSL_DISTRO_NAME = 'Ubuntu'
			expect(detectTerminalEnvironment()).toBe('wsl')
		})

		it('should return "linux" on native Linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', writable: true })
			delete process.env.WSL_DISTRO_NAME
			vi.mocked(readFileSync).mockReturnValue('Linux version 6.1.0-generic')
			expect(detectTerminalEnvironment()).toBe('linux')
		})

		it('should return "unsupported" for unknown platforms', () => {
			Object.defineProperty(process, 'platform', { value: 'freebsd', writable: true })
			expect(detectTerminalEnvironment()).toBe('unsupported')
		})
	})

	describe('detectWSLDistro', () => {
		it('should return WSL_DISTRO_NAME when set', () => {
			process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04'
			expect(detectWSLDistro()).toBe('Ubuntu-22.04')
		})

		it('should return undefined when WSL_DISTRO_NAME is not set', () => {
			delete process.env.WSL_DISTRO_NAME
			expect(detectWSLDistro()).toBeUndefined()
		})

		it('should return undefined when WSL_DISTRO_NAME is empty string', () => {
			process.env.WSL_DISTRO_NAME = ''
			expect(detectWSLDistro()).toBeUndefined()
		})
	})

	describe('isWindowsTerminalAvailable', () => {
		it('should return true when wt.exe is found', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)
			expect(await isWindowsTerminalAvailable()).toBe(true)
			expect(execa).toHaveBeenCalledWith('which', ['wt.exe'])
		})

		it('should return false when wt.exe is not found', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('not found'))
			expect(await isWindowsTerminalAvailable()).toBe(false)
		})
	})
})
