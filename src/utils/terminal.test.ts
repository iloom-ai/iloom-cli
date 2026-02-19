import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectPlatform, detectDarkMode, openTerminalWindow, openDualTerminalWindow, openMultipleTerminalWindows } from './terminal.js'
import { execa } from 'execa'

// Mock execa
vi.mock('execa')
// Mock fs
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}))

// Mock the terminal backend factory
const mockOpenSingle = vi.fn()
const mockOpenMultiple = vi.fn()
vi.mock('./terminal-backends/index.js', () => ({
	getTerminalBackend: vi.fn(() => Promise.resolve({
		name: 'mock',
		openSingle: (...args: unknown[]) => mockOpenSingle(...args),
		openMultiple: (...args: unknown[]) => mockOpenMultiple(...args),
	})),
}))

describe('detectPlatform', () => {
	const originalPlatform = process.platform

	afterEach(() => {
		// Restore original platform
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		})
	})

	it('should detect macOS (darwin)', () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
		expect(detectPlatform()).toBe('darwin')
	})

	it('should detect Linux', () => {
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			writable: true,
		})
		expect(detectPlatform()).toBe('linux')
	})

	it('should detect Windows (win32)', () => {
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			writable: true,
		})
		expect(detectPlatform()).toBe('win32')
	})

	it('should return unsupported for unknown platforms', () => {
		Object.defineProperty(process, 'platform', {
			value: 'freebsd',
			writable: true,
		})
		expect(detectPlatform()).toBe('unsupported')
	})
})

describe('detectDarkMode', () => {
	const originalPlatform = process.platform

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		})
	})

	it('should return "dark" when defaults indicates dark mode', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
		vi.mocked(execa).mockResolvedValue({ stdout: 'Dark' } as unknown)

		const result = await detectDarkMode()
		expect(result).toBe('dark')
		expect(execa).toHaveBeenCalledWith('defaults', ['read', '-g', 'AppleInterfaceStyle'])
	})

	it('should return "light" when defaults indicates light mode', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
		vi.mocked(execa).mockResolvedValue({ stdout: 'Light' } as unknown)

		const result = await detectDarkMode()
		expect(result).toBe('light')
	})

	it('should return "light" on non-macOS platforms', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			writable: true,
		})

		const result = await detectDarkMode()
		expect(result).toBe('light')
		// Should not call defaults on non-macOS
		expect(execa).not.toHaveBeenCalled()
	})

	it('should return "light" when defaults command fails (light mode)', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
		vi.mocked(execa).mockRejectedValue(new Error('AppleScript error'))

		const result = await detectDarkMode()
		expect(result).toBe('light')
	})

	it('should handle whitespace in defaults output', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
		vi.mocked(execa).mockResolvedValue({ stdout: '  Dark  \n' } as unknown)

		const result = await detectDarkMode()
		expect(result).toBe('dark')
	})
})

describe('openTerminalWindow', () => {
	beforeEach(() => {
		mockOpenSingle.mockResolvedValue(undefined)
	})

	it('should delegate to backend.openSingle', async () => {
		const options = {
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
		}

		await openTerminalWindow(options)

		expect(mockOpenSingle).toHaveBeenCalledWith(options)
	})

	it('should pass all options to backend', async () => {
		const options = {
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
			backgroundColor: { r: 128, g: 77, b: 179 },
			port: 3042,
			includeEnvSetup: true,
			includePortExport: true,
			title: 'Dev Server',
		}

		await openTerminalWindow(options)

		expect(mockOpenSingle).toHaveBeenCalledWith(options)
	})

	it('should propagate backend errors', async () => {
		mockOpenSingle.mockRejectedValue(new Error('Backend failed'))

		await expect(openTerminalWindow({})).rejects.toThrow('Backend failed')
	})
})

describe('openMultipleTerminalWindows', () => {
	beforeEach(() => {
		mockOpenMultiple.mockResolvedValue(undefined)
	})

	it('should require at least 2 options', async () => {
		await expect(
			openMultipleTerminalWindows([{ workspacePath: '/test' }])
		).rejects.toThrow('openMultipleTerminalWindows requires at least 2 terminal options')
	})

	it('should delegate to backend.openMultiple', async () => {
		const optionsArray = [
			{ workspacePath: '/test/1', command: 'cmd1' },
			{ workspacePath: '/test/2', command: 'cmd2' },
		]

		await openMultipleTerminalWindows(optionsArray)

		expect(mockOpenMultiple).toHaveBeenCalledWith(optionsArray)
	})

	it('should propagate backend errors', async () => {
		mockOpenMultiple.mockRejectedValue(new Error('Backend failed'))

		await expect(
			openMultipleTerminalWindows([
				{ command: 'cmd1' },
				{ command: 'cmd2' },
			])
		).rejects.toThrow('Backend failed')
	})
})

describe('openDualTerminalWindow', () => {
	beforeEach(() => {
		mockOpenMultiple.mockResolvedValue(undefined)
	})

	it('should delegate to openMultipleTerminalWindows with two options', async () => {
		const opts1 = { workspacePath: '/test/1', command: 'cmd1' }
		const opts2 = { workspacePath: '/test/2', command: 'cmd2' }

		await openDualTerminalWindow(opts1, opts2)

		expect(mockOpenMultiple).toHaveBeenCalledWith([opts1, opts2])
	})
})
