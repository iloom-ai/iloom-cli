import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectPlatform, openTerminalWindow, openDualTerminalWindow } from './terminal.js'
import { execa } from 'execa'
import { existsSync } from 'node:fs'

// Mock execa
vi.mock('execa')
// Mock fs
vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
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

describe('openTerminalWindow', () => {
	const originalPlatform = process.platform

	beforeEach(() => {
		vi.clearAllMocks()
		// Set to macOS by default
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
	})

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		})
	})

	it('should throw error on non-macOS platforms', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			writable: true,
		})

		await expect(openTerminalWindow({})).rejects.toThrow(
			'Terminal window launching not yet supported on linux'
		)
	})

	it('should create AppleScript for macOS', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
		})

		expect(execa).toHaveBeenCalledWith('osascript', ['-e', expect.any(String)])
		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		expect(applescript).toContain('tell application "Terminal"')
		expect(applescript).toContain(" cd '/Users/test/workspace'") // Commands now start with space
	})

	it('should escape single quotes in paths', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: "/Users/test/workspace's/path",
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Single quotes should be escaped as '\'' within the do script string
		// The full pattern is: do script " cd '/Users/test/workspace'\''s/path'" (note leading space)
		expect(applescript).toContain(" cd '/Users/test/workspace'\\\\''s/path'")
	})

	it('should include environment setup when requested', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			includeEnvSetup: true,
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		expect(applescript).toContain('source .env')
	})

	it('should export PORT variable when provided', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			port: 3042,
			includePortExport: true,
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		expect(applescript).toContain('export PORT=3042')
	})

	it('should not export PORT when includePortExport is false', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			port: 3042,
			includePortExport: false,
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		expect(applescript).not.toContain('export PORT')
	})

	it('should apply background color when provided', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			backgroundColor: { r: 128, g: 77, b: 179 },
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// 8-bit RGB (0-255) converted to 16-bit RGB (0-65535): multiply by 257
		// 128 * 257 = 32896, 77 * 257 = 19789, 179 * 257 = 46003
		expect(applescript).toContain('set background color of newTab to {32896, 19789, 46003}')
	})

	it('should execute command in terminal when provided', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		expect(applescript).toContain('pnpm dev')
	})

	it('should handle multi-command sequences with &&', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			includeEnvSetup: true,
			port: 3042,
			includePortExport: true,
			command: 'code . && pnpm dev',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Should have all commands joined with &&
		expect(applescript).toContain('&&')
		expect(applescript).toContain('source .env')
		expect(applescript).toContain('export PORT=3042')
		expect(applescript).toContain('code . && pnpm dev')
	})

	it('should activate Terminal.app after opening', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
		})

		// Should call execa twice: once for terminal creation, once for activation
		expect(execa).toHaveBeenCalledTimes(2)
		expect(execa).toHaveBeenNthCalledWith(2, 'osascript', [
			'-e',
			'tell application "Terminal" to activate',
		])
	})

	it('should throw error when AppleScript fails', async () => {
		vi.mocked(execa).mockRejectedValue(new Error('AppleScript execution failed'))

		await expect(
			openTerminalWindow({
				workspacePath: '/Users/test/workspace',
			})
		).rejects.toThrow('Failed to open terminal window: AppleScript execution failed')
	})

	it('should escape double quotes in commands', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'echo "Hello World"',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Double quotes should be escaped as \"
		expect(applescript).toContain('echo \\"Hello World\\"')
	})

	it('should escape backslashes in commands', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'echo \\$PATH',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Backslashes should be escaped as \\
		expect(applescript).toContain('echo \\\\$PATH')
	})

	it('should prefix commands with space to prevent shell history pollution', async () => {
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// The entire command sequence should start with a space
		// This prevents commands from appearing in shell history when HISTCONTROL=ignorespace
		expect(applescript).toMatch(/do script " [^"]+/)
	})

	it('should use iTerm2 when available for single terminal', async () => {
		vi.mocked(existsSync).mockReturnValue(true) // iTerm2 exists
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
		})

		// Should call osascript once (iTerm2 script includes activation)
		expect(execa).toHaveBeenCalledTimes(1)
		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string

		// Verify iTerm2 AppleScript structure
		expect(applescript).toContain('tell application id "com.googlecode.iterm2"')
		expect(applescript).toContain('create window with default profile')
		expect(applescript).toContain('activate')
		expect(applescript).not.toContain('tell application "Terminal"')
	})

	it('should set session name when title provided in iTerm2 mode', async () => {
		vi.mocked(existsSync).mockReturnValue(true) // iTerm2 exists
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
			title: 'Dev Server - Issue #42',
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Verify session name is set with escaped title
		expect(applescript).toContain('set name of s1 to "Dev Server - Issue #42"')
	})

	it('should apply background color in iTerm2 mode', async () => {
		vi.mocked(existsSync).mockReturnValue(true) // iTerm2 exists
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
			backgroundColor: { r: 128, g: 77, b: 179 },
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// 8-bit RGB (0-255) converted to 16-bit RGB (0-65535): multiply by 257
		// 128 * 257 = 32896, 77 * 257 = 19789, 179 * 257 = 46003
		expect(applescript).toContain('set background color of s1 to {32896, 19789, 46003}')
	})

	it('should fall back to Terminal.app when iTerm2 not available', async () => {
		vi.mocked(existsSync).mockReturnValue(false) // iTerm2 not available
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
		})

		// Should call execa twice: once for terminal creation, once for activation
		expect(execa).toHaveBeenCalledTimes(2)
		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string

		// Verify Terminal.app AppleScript is used, not iTerm2
		expect(applescript).toContain('tell application "Terminal"')
		expect(applescript).not.toContain('tell application id "com.googlecode.iterm2"')
	})

	it('should handle all options in iTerm2 single-tab mode', async () => {
		vi.mocked(existsSync).mockReturnValue(true) // iTerm2 exists
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openTerminalWindow({
			workspacePath: '/Users/test/workspace',
			command: 'pnpm dev',
			title: 'Dev Server',
			backgroundColor: { r: 128, g: 77, b: 179 },
			port: 3042,
			includeEnvSetup: true,
			includePortExport: true,
		})

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string

		// Verify all options are present in the iTerm2 script
		expect(applescript).toContain('/Users/test/workspace')
		expect(applescript).toContain('source .env')
		expect(applescript).toContain('export PORT=3042')
		expect(applescript).toContain('pnpm dev')
		expect(applescript).toContain('set name of s1 to "Dev Server"')
		expect(applescript).toContain('set background color of s1 to {32896, 19789, 46003}')
	})
})

describe('openDualTerminalWindow', () => {
	const originalPlatform = process.platform

	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			writable: true,
		})
	})

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			writable: true,
		})
	})

	it('should throw error on non-macOS platforms', async () => {
		Object.defineProperty(process, 'platform', {
			value: 'linux',
			writable: true,
		})

		await expect(
			openDualTerminalWindow(
				{ workspacePath: '/test/path1' },
				{ workspacePath: '/test/path2' }
			)
		).rejects.toThrow('Terminal window launching not yet supported on linux')
	})

	it('should use iTerm2 when available and create single window with two tabs', async () => {
		vi.mocked(existsSync).mockReturnValue(true) // iTerm2 exists
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openDualTerminalWindow(
			{
				workspacePath: '/Users/test/workspace1',
				command: 'il spin',
				title: 'Claude - Issue #42',
				backgroundColor: { r: 128, g: 77, b: 179 },
			},
			{
				workspacePath: '/Users/test/workspace2',
				command: 'pnpm dev',
				title: 'Dev Server - Issue #42',
				backgroundColor: { r: 128, g: 77, b: 179 },
				port: 3042,
				includePortExport: true,
			}
		)

		// Should call osascript once for iTerm2 dual tab creation
		expect(execa).toHaveBeenCalledWith('osascript', ['-e', expect.any(String)])
		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string

		// Verify iTerm2 AppleScript structure (uses application id, not name)
		expect(applescript).toContain('tell application id "com.googlecode.iterm2"')
		expect(applescript).toContain('create window with default profile')
		expect(applescript).toContain('create tab with default profile')

		// Verify both commands are present
		expect(applescript).toContain('il spin')
		expect(applescript).toContain('pnpm dev')

		// Verify both paths
		expect(applescript).toContain('/Users/test/workspace1')
		expect(applescript).toContain('/Users/test/workspace2')

		// Verify background colors applied to both tabs (16-bit RGB)
		// 8-bit RGB (0-255) converted to 16-bit RGB (0-65535): multiply by 257
		// 128 * 257 = 32896, 77 * 257 = 19789, 179 * 257 = 46003
		expect(applescript).toContain('{32896, 19789, 46003}')

		// Verify tab titles
		expect(applescript).toContain('Claude - Issue #42')
		expect(applescript).toContain('Dev Server - Issue #42')

		// Verify port export in second tab
		expect(applescript).toContain('export PORT=3042')

		// Verify iTerm2 is activated
		expect(applescript).toContain('activate')
	})

	it('should fall back to Terminal.app when iTerm2 not available', async () => {
		vi.mocked(existsSync).mockReturnValue(false) // iTerm2 not available
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openDualTerminalWindow(
			{
				workspacePath: '/Users/test/workspace1',
				command: 'il spin',
			},
			{
				workspacePath: '/Users/test/workspace2',
				command: 'pnpm dev',
			}
		)

		// Should call osascript multiple times for Terminal.app (2 windows + 2 activations)
		expect(execa).toHaveBeenCalled()
		const calls = vi.mocked(execa).mock.calls

		// Check that Terminal.app is used, not iTerm2
		const firstScript = calls[0][1]?.[1] as string
		expect(firstScript).toContain('tell application "Terminal"')
		expect(firstScript).not.toContain('tell application "iTerm2"')
	})

	it('should handle paths with single quotes in iTerm2 mode', async () => {
		vi.mocked(existsSync).mockReturnValue(true)
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openDualTerminalWindow(
			{
				workspacePath: "/Users/test/workspace's/path1",
				command: 'echo test',
			},
			{
				workspacePath: "/Users/test/workspace's/path2",
				command: 'echo test2',
			}
		)

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Single quotes should be properly escaped in both paths
		expect(applescript).toContain("workspace'\\\\''s")
	})

	it('should handle environment setup in both tabs', async () => {
		vi.mocked(existsSync).mockReturnValue(true)
		vi.mocked(execa).mockResolvedValue({} as unknown)

		await openDualTerminalWindow(
			{
				workspacePath: '/Users/test/workspace1',
				command: 'il spin',
				includeEnvSetup: true,
			},
			{
				workspacePath: '/Users/test/workspace2',
				command: 'pnpm dev',
				includeEnvSetup: true,
			}
		)

		const applescript = vi.mocked(execa).mock.calls[0][1]?.[1] as string
		// Should include source .env for both tabs
		const envCount = (applescript.match(/source \.env/g) || []).length
		expect(envCount).toBe(2)
	})
})
