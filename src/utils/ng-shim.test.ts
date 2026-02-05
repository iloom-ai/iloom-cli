import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import { createNgShim, isWindows } from './ng-shim.js'

// Mock fs-extra
vi.mock('fs-extra')

// Mock the logger
vi.mock('./logger-context.js', () => ({
	getLogger: () => ({
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	}),
}))

describe('ng-shim', () => {
	const mockWorkspacePath = '/test/workspace'
	const mockTempDir = '/tmp/iloom-ng-shim-abc123'
	const originalPlatform = process.platform

	beforeEach(() => {
		vi.mocked(fs.mkdtemp).mockResolvedValue(mockTempDir)
		vi.mocked(fs.writeFile).mockResolvedValue()
		vi.mocked(fs.remove).mockResolvedValue()
	})

	afterEach(() => {
		// Restore original platform after each test
		Object.defineProperty(process, 'platform', { value: originalPlatform })
	})

	describe('isWindows', () => {
		it('should return true on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32' })
			expect(isWindows()).toBe(true)
		})

		it('should return false on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			expect(isWindows()).toBe(false)
		})

		it('should return false on Linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux' })
			expect(isWindows()).toBe(false)
		})
	})

	describe('createNgShim', () => {
		it('should create a temp directory with unique prefix', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			await createNgShim(4200, mockWorkspacePath)

			expect(fs.mkdtemp).toHaveBeenCalledWith(
				expect.stringContaining('iloom-ng-shim-')
			)
		})

		it('should return shimDir path', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			const result = await createNgShim(4200, mockWorkspacePath)

			expect(result.shimDir).toBe(mockTempDir)
		})

		it('should return a cleanup function', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			const result = await createNgShim(4200, mockWorkspacePath)

			expect(typeof result.cleanup).toBe('function')
		})

		it('should cleanup remove the temp directory', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			const result = await createNgShim(4200, mockWorkspacePath)

			await result.cleanup()

			expect(fs.remove).toHaveBeenCalledWith(mockTempDir)
		})

		it('should handle cleanup errors gracefully', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			vi.mocked(fs.remove).mockRejectedValue(new Error('Permission denied'))

			const result = await createNgShim(4200, mockWorkspacePath)

			// Should not throw
			await expect(result.cleanup()).resolves.not.toThrow()
		})

		it('should use os.tmpdir for temp directory base', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			await createNgShim(4200, mockWorkspacePath)

			expect(fs.mkdtemp).toHaveBeenCalledWith(
				path.join(os.tmpdir(), 'iloom-ng-shim-')
			)
		})

		describe('Unix (macOS/Linux)', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'darwin' })
			})

			it('should write an executable shell script named "ng"', async () => {
				await createNgShim(4200, mockWorkspacePath)

				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join(mockTempDir, 'ng'),
					expect.stringContaining('#!/bin/sh'),
					{ mode: 0o755 }
				)
			})

			it('should include correct Unix shim script content', async () => {
				await createNgShim(4200, mockWorkspacePath)

				const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
				const scriptContent = writeCall[1] as string

				// Should use Unix-style paths and environment variables
				expect(scriptContent).toContain('$ILOOM_WORKSPACE_PATH/node_modules/.bin/ng')
				expect(scriptContent).toContain('$ILOOM_TARGET_PORT')
				expect(scriptContent).toContain('"$@"')
				expect(scriptContent).toContain('--port')
				expect(scriptContent).toContain('exec')
			})

			it('should set executable permissions on Unix', async () => {
				await createNgShim(4200, mockWorkspacePath)

				expect(fs.writeFile).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(String),
					{ mode: 0o755 }
				)
			})

			it('should work on Linux platform', async () => {
				Object.defineProperty(process, 'platform', { value: 'linux' })
				await createNgShim(4200, mockWorkspacePath)

				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join(mockTempDir, 'ng'),
					expect.stringContaining('#!/bin/sh'),
					{ mode: 0o755 }
				)
			})
		})

		describe('Windows', () => {
			beforeEach(() => {
				Object.defineProperty(process, 'platform', { value: 'win32' })
			})

			it('should write a batch file named "ng.cmd"', async () => {
				await createNgShim(4200, mockWorkspacePath)

				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join(mockTempDir, 'ng.cmd'),
					expect.stringContaining('@echo off')
				)
			})

			it('should include correct Windows batch script content', async () => {
				await createNgShim(4200, mockWorkspacePath)

				const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
				const scriptContent = writeCall[1] as string

				// Should use Windows-style paths and environment variables
				expect(scriptContent).toContain('%ILOOM_WORKSPACE_PATH%')
				expect(scriptContent).toContain('\\node_modules\\.bin\\ng.cmd')
				expect(scriptContent).toContain('%ILOOM_TARGET_PORT%')
				expect(scriptContent).toContain('%*')
				expect(scriptContent).toContain('--port')
			})

			it('should not set file permissions on Windows', async () => {
				await createNgShim(4200, mockWorkspacePath)

				// On Windows, writeFile should be called without mode option
				expect(fs.writeFile).toHaveBeenCalledWith(
					expect.any(String),
					expect.any(String)
				)
				// Verify no mode was passed
				const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
				expect(writeCall[2]).toBeUndefined()
			})

			it('should use backslashes in Windows paths', async () => {
				await createNgShim(4200, mockWorkspacePath)

				const writeCall = vi.mocked(fs.writeFile).mock.calls[0]
				const scriptContent = writeCall[1] as string

				// Windows paths should use backslashes
				expect(scriptContent).toContain('\\node_modules\\')
				expect(scriptContent).toContain('\\.bin\\')
			})
		})
	})
})
