import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TerminalColorManager } from './TerminalColorManager.js'
import { execa } from 'execa'
import { generateColorFromBranchName } from '../utils/color.js'
import { logger } from '../utils/logger.js'
import { isWSL } from '../utils/platform-detect.js'

// Mock execa
vi.mock('execa')

// Mock platform-detect
vi.mock('../utils/platform-detect.js', () => ({
	isWSL: vi.fn().mockReturnValue(false),
}))

// Mock logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

// Mock color utilities
vi.mock('../utils/color.js', () => ({
	generateColorFromBranchName: vi.fn((branchName: string) => {
		// Return deterministic test data
		const mockColors = {
			'feature/test-branch': {
				rgb: { r: 220, g: 235, b: 248 },
				hex: '#dcebf8',
				index: 0,
			},
			'feature/another-branch': {
				rgb: { r: 248, g: 220, b: 235 },
				hex: '#f8dceb',
				index: 1,
			},
		}
		return mockColors[branchName as keyof typeof mockColors] || mockColors['feature/test-branch']
	}),
}))

describe('TerminalColorManager', () => {
	let manager: TerminalColorManager
	let originalPlatform: typeof process.platform

	beforeEach(() => {
		manager = new TerminalColorManager()
		originalPlatform = process.platform
		vi.clearAllMocks()
	})

	afterEach(() => {
		// Restore original platform
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
		})
		vi.clearAllMocks()
	})

	describe('applyTerminalColor - macOS', () => {
		beforeEach(() => {
			// Mock platform as macOS
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
			})
		})

		it('should execute osascript with correct AppleScript for macOS', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			await manager.applyTerminalColor('feature/test-branch')

			expect(execa).toHaveBeenCalledWith('osascript', expect.arrayContaining(['-e']))

			// Get the AppleScript that was executed
			const call = vi.mocked(execa).mock.calls[0]
			const appleScript = call[1][1]

			expect(appleScript).toContain('tell application "Terminal"')
			expect(appleScript).toContain('set background color')
		})

		it('should scale RGB values correctly for Terminal.app (0-255 → 0-65535)', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			await manager.applyTerminalColor('feature/test-branch')

			const call = vi.mocked(execa).mock.calls[0]
			const appleScript = call[1][1]

			// Color is {220, 235, 248} from mock
			// Should be scaled to {56320, 60160, 63488}
			expect(appleScript).toContain('56320') // 220 * 256
			expect(appleScript).toContain('60160') // 235 * 256
			expect(appleScript).toContain('63488') // 248 * 256
		})

		it('should handle different branch names with different colors', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			await manager.applyTerminalColor('feature/another-branch')

			const call = vi.mocked(execa).mock.calls[0]
			const appleScript = call[1][1]

			// Color is {248, 220, 235} from mock
			// Should be scaled to {63488, 56320, 60160}
			expect(appleScript).toContain('63488') // 248 * 256
			expect(appleScript).toContain('56320') // 220 * 256
			expect(appleScript).toContain('60160') // 235 * 256
		})

		it('should throw error if osascript fails', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('osascript not found'))

			await expect(manager.applyTerminalColor('feature/test-branch')).rejects.toThrow(
				/Failed to apply terminal color/
			)
		})

		it('should throw error with meaningful message on AppleScript execution failure', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('AppleScript syntax error'))

			await expect(manager.applyTerminalColor('feature/test-branch')).rejects.toThrow(
				/Failed to apply terminal color/
			)
			await expect(manager.applyTerminalColor('feature/test-branch')).rejects.toThrow(
				/AppleScript syntax error/
			)
		})
	})

	describe('applyTerminalColor - Linux', () => {
		beforeEach(() => {
			// Mock platform as Linux
			Object.defineProperty(process, 'platform', {
				value: 'linux',
			})
		})

		it('should not execute any commands on Linux', async () => {
			await manager.applyTerminalColor('feature/test-branch')

			expect(execa).not.toHaveBeenCalled()
		})

		it('should not throw error on Linux (graceful degradation)', async () => {
			await expect(manager.applyTerminalColor('feature/test-branch')).resolves.not.toThrow()
		})

		it('should log warning about limited Linux support on native Linux', async () => {
			vi.mocked(isWSL).mockReturnValue(false)

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('limited support on Linux')
			)
		})

		it('should log debug message about tab colors on WSL', async () => {
			vi.mocked(isWSL).mockReturnValue(true)

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Windows Terminal tab colors are applied at launch time')
			)
			expect(logger.warn).not.toHaveBeenCalled()
		})
	})

	describe('applyTerminalColor - Windows', () => {
		beforeEach(() => {
			// Mock platform as Windows
			Object.defineProperty(process, 'platform', {
				value: 'win32',
			})
		})

		it('should not execute any commands on Windows', async () => {
			await manager.applyTerminalColor('feature/test-branch')

			expect(execa).not.toHaveBeenCalled()
		})

		it('should not throw error on Windows (graceful degradation)', async () => {
			await expect(manager.applyTerminalColor('feature/test-branch')).resolves.not.toThrow()
		})

		it('should log warning about Windows not being supported', async () => {

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('not supported on Windows')
			)
		})
	})

	describe('applyTerminalColor - Unsupported platforms', () => {
		beforeEach(() => {
			// Mock platform as something unusual
			Object.defineProperty(process, 'platform', {
				value: 'freebsd',
			})
		})

		it('should not execute any commands on unsupported platforms', async () => {
			await manager.applyTerminalColor('feature/test-branch')

			expect(execa).not.toHaveBeenCalled()
		})

		it('should not throw error on unsupported platforms', async () => {
			await expect(manager.applyTerminalColor('feature/test-branch')).resolves.not.toThrow()
		})

		it('should log warning about unsupported platform', async () => {

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('not supported on')
			)
		})
	})

	describe('edge cases', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
			})
		})

		it('should handle branch names with special characters', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			await expect(
				manager.applyTerminalColor('feature/issue-37/terminal-colors')
			).resolves.not.toThrow()
			await expect(manager.applyTerminalColor('feat_issue_37')).resolves.not.toThrow()
			await expect(manager.applyTerminalColor('feature-branch')).resolves.not.toThrow()
		})

		it('should handle very long branch names', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			const longBranchName =
				'feature/very-long-branch-name-with-many-characters-that-might-cause-issues'
			await expect(manager.applyTerminalColor(longBranchName)).resolves.not.toThrow()
		})

		it('should handle branch names with unicode characters', async () => {
			vi.mocked(execa).mockResolvedValue({} as never)

			await expect(manager.applyTerminalColor('feature/emoji-🎨')).resolves.not.toThrow()
		})
	})

	describe('integration with color generation', () => {
		beforeEach(() => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
			})
			vi.mocked(execa).mockResolvedValue({} as never)
		})

		it('should generate color from branch name before applying', async () => {

			await manager.applyTerminalColor('feature/test-branch')

			expect(generateColorFromBranchName).toHaveBeenCalledWith('feature/test-branch')
		})

		it('should use generated color in AppleScript', async () => {
			await manager.applyTerminalColor('feature/test-branch')

			const call = vi.mocked(execa).mock.calls[0]
			const appleScript = call[1][1]

			// Should contain scaled RGB values from generated color
			expect(appleScript).toContain('background color')
		})
	})

	describe('platform detection', () => {
		it('should correctly detect macOS platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'darwin',
			})
			vi.mocked(execa).mockResolvedValue({} as never)

			await manager.applyTerminalColor('feature/test-branch')

			expect(execa).toHaveBeenCalled()
		})

		it('should correctly detect Linux platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'linux',
			})

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.warn).toHaveBeenCalled()
		})

		it('should correctly detect Windows platform', async () => {
			Object.defineProperty(process, 'platform', {
				value: 'win32',
			})

			await manager.applyTerminalColor('feature/test-branch')

			expect(logger.warn).toHaveBeenCalled()
		})
	})
})
