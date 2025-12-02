import { describe, it, expect, vi, beforeEach } from 'vitest'
import { needsFirstRunSetup, launchFirstRunSetup } from './first-run-setup.js'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'

// Mock fs modules
vi.mock('fs')
vi.mock('fs/promises')

// Mock logger
vi.mock('./logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

// Mock InitCommand
vi.mock('../commands/init.js', () => ({
	InitCommand: vi.fn(() => ({
		execute: vi.fn().mockResolvedValue(undefined),
	})),
}))

// Mock prompt utilities
vi.mock('./prompt.js', () => ({
	waitForKeypress: vi.fn().mockResolvedValue('Enter'),
}))

describe('first-run-setup', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('needsFirstRunSetup', () => {
		it('should return true when .iloom directory does not exist', async () => {
			vi.mocked(existsSync).mockReturnValue(false)

			const result = await needsFirstRunSetup()

			expect(result).toBe(true)
		})

		it('should return true when .iloom exists but both settings files are missing', async () => {
			vi.mocked(existsSync).mockImplementation((path) => {
				// .iloom directory exists
				if (path.toString().endsWith('.iloom')) return true
				// settings files don't exist
				return false
			})

			const result = await needsFirstRunSetup()

			expect(result).toBe(true)
		})

		it('should return true when .iloom exists but both settings files are empty', async () => {
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(readFile).mockResolvedValue('{}')

			const result = await needsFirstRunSetup()

			expect(result).toBe(true)
		})

		it('should return false when settings.json has content', async () => {
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(readFile).mockImplementation((path) => {
				if (path.toString().includes('settings.json')) {
					return Promise.resolve('{"mainBranch": "main"}')
				}
				return Promise.resolve('{}')
			})

			const result = await needsFirstRunSetup()

			expect(result).toBe(false)
		})

		it('should return false when settings.local.json has content', async () => {
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(readFile).mockImplementation((path) => {
				if (path.toString().includes('settings.local.json')) {
					return Promise.resolve('{"basePort": 3000}')
				}
				return Promise.resolve('{}')
			})

			const result = await needsFirstRunSetup()

			expect(result).toBe(false)
		})

		it('should return true when settings files have invalid JSON', async () => {
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(readFile).mockResolvedValue('invalid json')

			const result = await needsFirstRunSetup()

			expect(result).toBe(true)
		})

		it('should handle file read errors gracefully', async () => {
			vi.mocked(existsSync).mockReturnValue(true)
			vi.mocked(readFile).mockRejectedValue(new Error('Read error'))

			const result = await needsFirstRunSetup()

			expect(result).toBe(true)
		})
	})

	describe('launchFirstRunSetup', () => {
		it('should launch InitCommand with correct message', async () => {
			const { InitCommand } = await import('../commands/init.js')
			const { waitForKeypress } = await import('./prompt.js')
			const { logger } = await import('./logger.js')

			await launchFirstRunSetup()

			// Verify info messages
			expect(logger.info).toHaveBeenCalledWith(
				'First-time project setup detected.'
			)
			expect(logger.info).toHaveBeenCalledWith(
				'iloom will now launch an interactive configuration session with Claude.'
			)

			// Verify keypress wait
			expect(waitForKeypress).toHaveBeenCalledWith(
				'Press any key to start configuration...'
			)

			// Verify InitCommand execution
			expect(InitCommand).toHaveBeenCalled()
			const mockInstance = vi.mocked(InitCommand).mock.results[0].value
			expect(mockInstance.execute).toHaveBeenCalledWith(
				'Help me configure iloom settings for this project. This is my first time using iloom here. Note: Your iloom command will execute once we are done with configuration changes.'
			)

			// Verify completion message
			expect(logger.info).toHaveBeenCalledWith(
				'Configuration complete! Continuing with your original command...'
			)
		})
	})
})
