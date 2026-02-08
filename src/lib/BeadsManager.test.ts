import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BeadsManager, BeadsError } from './BeadsManager.js'
import { execa } from 'execa'

// Mock execa
vi.mock('execa', () => ({
	execa: vi.fn(),
}))

// Mock prompt utilities
vi.mock('../utils/prompt.js', () => ({
	promptConfirmation: vi.fn(),
	isInteractiveEnvironment: vi.fn(),
}))

// Mock logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

import { promptConfirmation, isInteractiveEnvironment } from '../utils/prompt.js'
import { logger } from '../utils/logger.js'

describe('BeadsManager', () => {
	let beadsManager: BeadsManager

	beforeEach(() => {
		beadsManager = new BeadsManager('/test/project')
	})

	describe('constructor', () => {
		it('should compute a stable beads directory from project path', () => {
			const manager = new BeadsManager('/test/project')
			const beadsDir = manager.getBeadsDir()

			// Should be under the default base dir with a hash suffix
			expect(beadsDir).toContain('iloom-ai/beads/')
			expect(beadsDir).toMatch(/\/[a-f0-9]{12}$/)
		})

		it('should produce different directories for different project paths', () => {
			const manager1 = new BeadsManager('/project/one')
			const manager2 = new BeadsManager('/project/two')

			expect(manager1.getBeadsDir()).not.toEqual(manager2.getBeadsDir())
		})

		it('should produce the same directory for the same project path', () => {
			const manager1 = new BeadsManager('/project/same')
			const manager2 = new BeadsManager('/project/same')

			expect(manager1.getBeadsDir()).toEqual(manager2.getBeadsDir())
		})

		it('should use custom beadsDir from settings', () => {
			const manager = new BeadsManager('/test/project', {
				beadsDir: '/custom/beads/path',
			})
			const beadsDir = manager.getBeadsDir()

			expect(beadsDir).toMatch(/^\/custom\/beads\/path\/[a-f0-9]{12}$/)
		})

		it('should expand tilde in beadsDir', () => {
			const manager = new BeadsManager('/test/project', {
				beadsDir: '~/.config/iloom-ai/beads',
			})
			const beadsDir = manager.getBeadsDir()

			// Should not contain tilde
			expect(beadsDir).not.toContain('~')
			expect(beadsDir).toContain('iloom-ai/beads/')
		})
	})

	describe('isInstalled', () => {
		it('should return true when bd is on PATH', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '/usr/local/bin/bd' } as never)

			const result = await beadsManager.isInstalled()
			expect(result).toBe(true)
		})

		it('should return false when bd is not on PATH', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))

			const result = await beadsManager.isInstalled()
			expect(result).toBe(false)
		})
	})

	describe('ensureInstalled', () => {
		it('should return immediately when bd is already installed', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '/usr/local/bin/bd' } as never)

			await beadsManager.ensureInstalled()

			// Only one call for `command -v bd`
			expect(execa).toHaveBeenCalledTimes(1)
		})

		it('should auto-install when autoInstall is true', async () => {
			// First call: command -v bd (not found)
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			// Second call: curl | bash install script
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
			// Third call: verify installation (command -v bd)
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '/usr/local/bin/bd' } as never)

			await beadsManager.ensureInstalled(true)

			expect(execa).toHaveBeenCalledTimes(3)
		})

		it('should prompt in interactive mode when autoInstall is false', async () => {
			// First call: command -v bd (not found)
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			vi.mocked(isInteractiveEnvironment).mockReturnValue(true)
			vi.mocked(promptConfirmation).mockResolvedValueOnce(true)
			// Second call: curl | bash install script
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
			// Third call: verify installation
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '/usr/local/bin/bd' } as never)

			await beadsManager.ensureInstalled(false)

			expect(promptConfirmation).toHaveBeenCalledWith(
				'Swarm mode requires Beads. Install now?',
				true,
			)
		})

		it('should throw when user declines installation in interactive mode', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			vi.mocked(isInteractiveEnvironment).mockReturnValue(true)
			vi.mocked(promptConfirmation).mockResolvedValueOnce(false)

			await expect(beadsManager.ensureInstalled(false)).rejects.toThrow(
				'Beads CLI is required for swarm mode',
			)
		})

		it('should throw in non-interactive mode when autoInstall is false', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			vi.mocked(isInteractiveEnvironment).mockReturnValue(false)

			await expect(beadsManager.ensureInstalled(false)).rejects.toThrow(
				'Beads CLI is required for swarm mode but is not installed',
			)

			expect(promptConfirmation).not.toHaveBeenCalled()
		})

		it('should auto-install in non-interactive mode when autoInstall is true', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			vi.mocked(isInteractiveEnvironment).mockReturnValue(false)
			// Install
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
			// Verify
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '/usr/local/bin/bd' } as never)

			await beadsManager.ensureInstalled(true)

			expect(promptConfirmation).not.toHaveBeenCalled()
		})

		it('should throw when installation completes but bd is still not on PATH', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))
			// Install
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '' } as never)
			// Verify fails
			vi.mocked(execa).mockRejectedValueOnce(new Error('not found'))

			await expect(beadsManager.ensureInstalled(true)).rejects.toThrow(
				'Beads CLI installation completed but bd is not available on PATH',
			)
		})
	})

	describe('init', () => {
		it('should call bd init with correct flags and environment', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.init()

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['init', '--quiet', '--skip-hooks', '--skip-merge-driver'],
				expect.objectContaining({
					cwd: '/test/project',
					env: expect.objectContaining({
						BEADS_DIR: beadsManager.getBeadsDir(),
						BEADS_NO_DAEMON: '1',
					}),
				}),
			)
		})

		it('should throw BeadsError on failure', async () => {
			const error = new Error('init failed') as Error & { stderr: string; exitCode: number }
			error.stderr = 'Permission denied'
			error.exitCode = 1
			vi.mocked(execa).mockRejectedValueOnce(error)

			await expect(beadsManager.init()).rejects.toThrow(BeadsError)
		})

		it('should succeed silently when beads is already initialized', async () => {
			const error = new Error('bd init failed') as Error & { stderr: string; exitCode: number }
			error.stderr = 'This workspace is already initialized.'
			error.exitCode = 1
			vi.mocked(execa).mockRejectedValueOnce(error)

			await expect(beadsManager.init()).resolves.toBeUndefined()
			expect(logger.debug).toHaveBeenCalledWith('Beads already initialized, skipping')
		})

		it('should re-throw non-"already initialized" BeadsErrors', async () => {
			const error = new Error('bd init failed') as Error & { stderr: string; exitCode: number }
			error.stderr = 'Permission denied: /some/path'
			error.exitCode = 1
			vi.mocked(execa).mockRejectedValueOnce(error)

			await expect(beadsManager.init()).rejects.toThrow(BeadsError)
		})

		it('should re-throw non-"already initialized" errors even if not ExecaError', async () => {
			vi.mocked(execa).mockRejectedValueOnce(new TypeError('unexpected type error'))

			// execBd wraps all errors as BeadsError, so init() sees a BeadsError
			// whose stderr does not contain "already initialized" and re-throws it
			await expect(beadsManager.init()).rejects.toThrow(BeadsError)
		})

		it('should handle stderr containing "already initialized" anywhere in the message', async () => {
			const error = new Error('bd init failed') as Error & { stderr: string; exitCode: number }
			error.stderr = 'Found existing database: /path/to/beads.db\n\nThis workspace is already initialized.\n\nTo use the existing database...'
			error.exitCode = 1
			vi.mocked(execa).mockRejectedValueOnce(error)

			await expect(beadsManager.init()).resolves.toBeUndefined()
		})
	})

	describe('create', () => {
		it('should create a task with title', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: 'task-123',
				stderr: '',
			} as never)

			const taskId = await beadsManager.create('Implement feature X')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['create', 'Implement feature X'],
				expect.objectContaining({
					env: expect.objectContaining({
						BEADS_DIR: beadsManager.getBeadsDir(),
						BEADS_NO_DAEMON: '1',
					}),
				}),
			)
			expect(taskId).toBe('task-123')
		})

		it('should create a task with custom id and priority', async () => {
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: '42',
				stderr: '',
			} as never)

			const taskId = await beadsManager.create('Fix bug', {
				id: '42',
				priority: 5,
			})

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['create', 'Fix bug', '--id', '42', '--priority', '5'],
				expect.anything(),
			)
			expect(taskId).toBe('42')
		})
	})

	describe('addDependency', () => {
		it('should add a blocking dependency', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.addDependency('child-1', 'parent-1')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['dep', 'add', 'child-1', 'parent-1'],
				expect.anything(),
			)
		})
	})

	describe('ready', () => {
		it('should return parsed tasks with no open blockers', async () => {
			const tasks = [
				{ id: '1', title: 'Task A', status: 'open' },
				{ id: '2', title: 'Task B', status: 'open' },
			]
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(tasks),
				stderr: '',
			} as never)

			const result = await beadsManager.ready()

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['ready', '--json'],
				expect.anything(),
			)
			expect(result).toEqual(tasks)
		})

		it('should throw BeadsError when output is not valid JSON', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'not json',
				stderr: '',
			} as never)

			await expect(beadsManager.ready()).rejects.toThrow(BeadsError)
			await expect(beadsManager.ready()).rejects.toThrow('Failed to parse bd ready output as JSON')
		})
	})

	describe('claim', () => {
		it('should atomically claim a task', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.claim('task-1')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['update', '--claim', 'task-1'],
				expect.anything(),
			)
		})
	})

	describe('close', () => {
		it('should close a task', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.close('task-1')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['close', 'task-1'],
				expect.anything(),
			)
		})

		it('should close a task with reason', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.close('task-1', 'Completed successfully')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['close', 'task-1', '--reason', 'Completed successfully'],
				expect.anything(),
			)
		})
	})

	describe('releaseClaim', () => {
		it('should release a claimed task', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '', stderr: '' } as never)

			await beadsManager.releaseClaim('task-1')

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['update', '--release', 'task-1'],
				expect.anything(),
			)
		})
	})

	describe('environment variables', () => {
		it('should set BEADS_DIR and BEADS_NO_DAEMON=1 in all bd commands', async () => {
			vi.mocked(execa).mockResolvedValueOnce({ stdout: '[]', stderr: '' } as never)

			await beadsManager.ready()

			const callArgs = vi.mocked(execa).mock.calls[0]
			expect(callArgs[2]).toEqual(
				expect.objectContaining({
					env: expect.objectContaining({
						BEADS_DIR: beadsManager.getBeadsDir(),
						BEADS_NO_DAEMON: '1',
					}),
				}),
			)
		})

		it('should only pass allowed environment variables to bd subprocess', async () => {
			// Set a secret env var that should NOT be passed through
			process.env.SECRET_API_KEY = 'super-secret'
			process.env.BD_CUSTOM = 'bd-value'

			vi.mocked(execa).mockResolvedValueOnce({ stdout: '[]', stderr: '' } as never)

			await beadsManager.ready()

			const callArgs = vi.mocked(execa).mock.calls[0]
			const env = (callArgs[2] as { env: Record<string, string> }).env

			// Should NOT include arbitrary env vars
			expect(env).not.toHaveProperty('SECRET_API_KEY')
			// Should include BD_* prefixed vars
			expect(env.BD_CUSTOM).toBe('bd-value')
			// Should include required vars
			expect(env.BEADS_DIR).toBe(beadsManager.getBeadsDir())
			expect(env.BEADS_NO_DAEMON).toBe('1')

			// Clean up
			delete process.env.SECRET_API_KEY
			delete process.env.BD_CUSTOM
		})
	})

	describe('list', () => {
		it('should return parsed tasks', async () => {
			const tasks = [
				{ id: '1', title: 'Task A', status: 'open' },
				{ id: '2', title: 'Task B', status: 'claimed' },
			]
			vi.mocked(execa).mockResolvedValueOnce({
				stdout: JSON.stringify(tasks),
				stderr: '',
			} as never)

			const result = await beadsManager.list()

			expect(execa).toHaveBeenCalledWith(
				'bd',
				['list', '--json'],
				expect.anything(),
			)
			expect(result).toEqual(tasks)
		})

		it('should throw BeadsError when output is not valid JSON', async () => {
			vi.mocked(execa).mockResolvedValue({
				stdout: 'not json',
				stderr: '',
			} as never)

			await expect(beadsManager.list()).rejects.toThrow(BeadsError)
			await expect(beadsManager.list()).rejects.toThrow('Failed to parse bd list output as JSON')
		})
	})
})
