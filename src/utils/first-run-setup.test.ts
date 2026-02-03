import { describe, it, expect, vi, beforeEach } from 'vitest'
import { needsFirstRunSetup, launchFirstRunSetup } from './first-run-setup.js'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { FirstRunManager } from './FirstRunManager.js'
import { getRepoRoot } from './git.js'
import { InitCommand } from '../commands/init.js'

// Mock fs modules
vi.mock('fs')
vi.mock('fs/promises')

// Mock FirstRunManager
vi.mock('./FirstRunManager.js')

// Mock git utilities
vi.mock('./git.js', () => ({
	getRepoRoot: vi.fn(),
}))

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
	promptConfirmation: vi.fn().mockResolvedValue(true),
}))

describe('first-run-setup', () => {
	const mockIsProjectConfigured = vi.fn()
	const mockMarkProjectAsConfigured = vi.fn()
	const mockRepoRoot = '/test/repo/root'

	beforeEach(() => {
		vi.clearAllMocks()
		// Default mock: git repo root found
		vi.mocked(getRepoRoot).mockResolvedValue(mockRepoRoot)
		// Default mock: project is not configured globally
		mockIsProjectConfigured.mockResolvedValue(false)
		mockMarkProjectAsConfigured.mockResolvedValue(undefined)
		vi.mocked(FirstRunManager).mockImplementation(() => ({
			isProjectConfigured: mockIsProjectConfigured,
			markProjectAsConfigured: mockMarkProjectAsConfigured,
			isFirstRun: vi.fn(),
			markAsRun: vi.fn(),
		}) as unknown as FirstRunManager)
	})

	describe('needsFirstRunSetup', () => {
		it('should use git repo root for project path resolution', async () => {
			mockIsProjectConfigured.mockResolvedValue(true)

			await needsFirstRunSetup()

			// Verify getRepoRoot was called
			expect(getRepoRoot).toHaveBeenCalled()
			// Verify isProjectConfigured was called with the repo root path
			expect(mockIsProjectConfigured).toHaveBeenCalledWith(mockRepoRoot)
		})

		it('should fall back to process.cwd() when not in a git repo', async () => {
			vi.mocked(getRepoRoot).mockResolvedValue(null)
			mockIsProjectConfigured.mockResolvedValue(true)
			const originalCwd = process.cwd()

			await needsFirstRunSetup()

			// Verify methods were called with cwd (since getRepoRoot returned null)
			expect(mockIsProjectConfigured).toHaveBeenCalledWith(originalCwd)
		})

		it('should return false when project is tracked as configured globally', async () => {
			mockIsProjectConfigured.mockResolvedValue(true)

			const result = await needsFirstRunSetup()

			expect(result).toBe(false)
			// Should not check local files when globally configured
			expect(existsSync).not.toHaveBeenCalled()
		})

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
		describe('zero setup flow', () => {
			it('should display defaults and mark as configured when user accepts (Y)', async () => {
				const { promptConfirmation } = await import('./prompt.js')
				const { InitCommand } = await import('../commands/init.js')
				const { logger } = await import('./logger.js')

				vi.mocked(promptConfirmation).mockResolvedValue(true)

				await launchFirstRunSetup()

				// Verify promptConfirmation was called with correct args
				expect(promptConfirmation).toHaveBeenCalledWith('Are these defaults OK?', true)

				// Verify markProjectAsConfigured was called
				expect(mockMarkProjectAsConfigured).toHaveBeenCalledWith(mockRepoRoot)

				// Verify InitCommand was NOT called
				expect(InitCommand).not.toHaveBeenCalled()

				// Verify success message
				expect(logger.info).toHaveBeenCalledWith(
					expect.stringContaining('Configuration complete! Using defaults.')
				)
				expect(logger.info).toHaveBeenCalledWith(
					'You can run `il init` anytime to customize settings.'
				)
			})

			it('should display formatted defaults box with correct values', async () => {
				const { promptConfirmation } = await import('./prompt.js')
				const { logger } = await import('./logger.js')

				vi.mocked(promptConfirmation).mockResolvedValue(true)

				await launchFirstRunSetup()

				// Verify defaults are displayed (checking for key values in logged info)
				const infoCalls = vi.mocked(logger.info).mock.calls.map(call => call[0])

				// Check that key defaults are displayed
				expect(infoCalls.some(call => call.includes('Main Branch:') && call.includes('main'))).toBe(true)
				expect(infoCalls.some(call => call.includes('IDE:') && call.includes('vscode'))).toBe(true)
				expect(infoCalls.some(call => call.includes('Issue Tracker:') && call.includes('GitHub Issues'))).toBe(true)
				expect(infoCalls.some(call => call.includes('Merge Mode:') && call.includes('local'))).toBe(true)
				expect(infoCalls.some(call => call.includes('Base Port:') && call.includes('3000'))).toBe(true)
			})

			it('should launch full wizard when user declines defaults (N)', async () => {
				const { promptConfirmation, waitForKeypress } = await import('./prompt.js')
				const { InitCommand } = await import('../commands/init.js')
				const { logger } = await import('./logger.js')

				vi.mocked(promptConfirmation).mockResolvedValue(false)

				await launchFirstRunSetup()

				// Verify InitCommand was called after declining
				expect(InitCommand).toHaveBeenCalled()
				const mockInstance = vi.mocked(InitCommand).mock.results[0].value
				expect(mockInstance.execute).toHaveBeenCalledWith(
					'Help me configure iloom settings for this project. This is my first time using iloom here. Note: Your iloom command will execute once we are done with configuration changes.'
				)

				// Verify waitForKeypress was called
				expect(waitForKeypress).toHaveBeenCalledWith(
					'Press any key to start configuration...'
				)

				// Verify completion message from wizard path
				expect(logger.info).toHaveBeenCalledWith(
					'Configuration complete! Continuing with your original command...'
				)
			})

			it('should show wizard launch message when declining defaults', async () => {
				const { promptConfirmation } = await import('./prompt.js')
				const { logger } = await import('./logger.js')

				vi.mocked(promptConfirmation).mockResolvedValue(false)

				await launchFirstRunSetup()

				expect(logger.info).toHaveBeenCalledWith(
					'iloom will now launch an interactive configuration session with Claude.'
				)
			})
		})

		it('should delegate project marking to InitCommand.execute() when wizard is launched', async () => {
			const { promptConfirmation } = await import('./prompt.js')
			// Decline defaults to trigger wizard path
			vi.mocked(promptConfirmation).mockResolvedValue(false)

			await launchFirstRunSetup()

			// Verify InitCommand.execute() was called, which handles marking internally
			const mockInstance = vi.mocked(InitCommand).mock.results[0].value
			expect(mockInstance.execute).toHaveBeenCalled()
		})
	})
})
