import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NativeDevServerStrategy } from './NativeDevServerStrategy.js'
import { ProcessManager } from './process/ProcessManager.js'
import { execa, type ExecaChildProcess } from 'execa'
import { setTimeout } from 'timers/promises'
import * as devServerUtils from '../utils/dev-server.js'
import * as packageManagerUtils from '../utils/package-manager.js'
import * as packageJsonUtils from '../utils/package-json.js'

// Mock dependencies
vi.mock('execa')
vi.mock('timers/promises')
vi.mock('./process/ProcessManager.js')
vi.mock('../utils/dev-server.js')
vi.mock('../utils/package-manager.js')
vi.mock('../utils/package-json.js')

vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

describe('NativeDevServerStrategy', () => {
	let strategy: NativeDevServerStrategy
	let mockProcessManager: ProcessManager
	const mockWorktreePath = '/test/worktrees/issue-87'

	beforeEach(() => {
		mockProcessManager = new ProcessManager()
		strategy = new NativeDevServerStrategy(mockProcessManager, 5000, 100)

		vi.mocked(packageJsonUtils.getPackageScripts).mockResolvedValue({
			dev: { command: 'pnpm dev', source: 'package-manager' },
		})
	})

	describe('isRunning', () => {
		it('should return true when a process is listening on the port', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue({
				pid: 12345,
				name: 'node',
				command: 'pnpm dev',
				port,
				isDevServer: true,
			})

			const result = await strategy.isRunning(port)

			expect(result).toBe(true)
			expect(mockProcessManager.detectDevServer).toHaveBeenCalledWith(port)
		})

		it('should return false when no process is listening on the port', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			const result = await strategy.isRunning(port)

			expect(result).toBe(false)
		})
	})

	describe('startBackground', () => {
		it('should start server in background when dev script exists', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground(mockWorktreePath, port)

			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					cwd: mockWorktreePath,
					env: expect.objectContaining({
						PORT: '3087',
					}),
					stdio: 'ignore',
					detached: true,
				})
			)
			expect(mockProcess.unref).toHaveBeenCalled()
		})

		it('should skip start and return when no dev script exists', async () => {
			const port = 3087

			vi.mocked(packageJsonUtils.getPackageScripts).mockResolvedValue({
				build: { command: 'tsc', source: 'package-manager' },
			})

			await strategy.startBackground(mockWorktreePath, port)

			expect(execa).not.toHaveBeenCalled()
		})

		it('should throw when server fails to start within timeout', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			// Server never starts
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			// Short timeout strategy
			const shortTimeoutStrategy = new NativeDevServerStrategy(mockProcessManager, 500, 100)

			await expect(shortTimeoutStrategy.startBackground(mockWorktreePath, port)).rejects.toThrow(
				'Dev server failed to start within 500ms timeout'
			)
		})

		it('should forward envOverrides to the process', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground(mockWorktreePath, port, { DATABASE_URL: 'postgres://test' })

			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					env: expect.objectContaining({
						DATABASE_URL: 'postgres://test',
						PORT: '3087',
					}),
				})
			)
		})
	})

	describe('startForeground', () => {
		it('should use runScript for standard foreground mode', async () => {
			const port = 3087
			const onProcessStarted = vi.fn()

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			const result = await strategy.startForeground(mockWorktreePath, port, {
				redirectToStderr: false,
				onProcessStarted,
				envOverrides: { DATABASE_URL: 'postgres://test' },
			})

			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[],
				expect.objectContaining({
					env: expect.objectContaining({
						DATABASE_URL: 'postgres://test',
						PORT: '3087',
					}),
					foreground: true,
					onStart: onProcessStarted,
					noCi: true,
				})
			)
			expect(result).toEqual({ pid: 12345 })
		})

		it('should use execa with stderr redirect when redirectToStderr is true', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await strategy.startForeground(mockWorktreePath, port, {
				redirectToStderr: true,
				envOverrides: { DATABASE_URL: 'postgres://test' },
			})

			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					stdio: [process.stdin, process.stderr, process.stderr],
					env: expect.objectContaining({
						DATABASE_URL: 'postgres://test',
						PORT: '3087',
					}),
				})
			)
			expect(packageManagerUtils.runScript).not.toHaveBeenCalled()
		})

		it('should call onProcessStarted in redirectToStderr mode', async () => {
			const port = 3087
			const onProcessStarted = vi.fn()

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await strategy.startForeground(mockWorktreePath, port, {
				redirectToStderr: true,
				onProcessStarted,
			})

			expect(onProcessStarted).toHaveBeenCalledWith(12345)
		})
	})

	describe('stop', () => {
		it('should kill a tracked server process and return true', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			// Start a server to track it
			await strategy.startBackground(mockWorktreePath, port)

			const result = await strategy.stop(port)

			expect(result).toBe(true)
			expect(mockProcess.kill).toHaveBeenCalled()
		})

		it('should return false when no server is tracked for the port', async () => {
			const port = 3087

			const result = await strategy.stop(port)

			expect(result).toBe(false)
		})
	})

	describe('stopAll', () => {
		it('should stop all tracked server processes', async () => {
			const port = 3087

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground(mockWorktreePath, port)
			await strategy.stopAll()

			expect(mockProcess.kill).toHaveBeenCalled()
		})
	})

	describe('waitForReady', () => {
		it('should return true when server starts within timeout', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const result = await strategy.waitForReady(port)

			expect(result).toBe(true)
		})

		it('should return false when server does not start within timeout', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const shortTimeoutStrategy = new NativeDevServerStrategy(mockProcessManager, 500, 100)
			const result = await shortTimeoutStrategy.waitForReady(port)

			expect(result).toBe(false)
		})
	})
})
