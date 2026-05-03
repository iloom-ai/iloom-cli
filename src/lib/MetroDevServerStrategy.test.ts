import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetroDevServerStrategy } from './MetroDevServerStrategy.js'
import { ProcessManager } from './process/ProcessManager.js'
import { execa, type ExecaChildProcess } from 'execa'
import { setTimeout } from 'timers/promises'

// Mock dependencies
vi.mock('execa')
vi.mock('timers/promises')
vi.mock('./process/ProcessManager.js')

vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

vi.mock('../utils/terminal.js', () => ({
	restoreTerminalState: vi.fn(),
}))

describe('MetroDevServerStrategy', () => {
	let strategy: MetroDevServerStrategy
	let mockProcessManager: ProcessManager
	const mockWorktreePath = '/test/worktrees/issue-87'

	beforeEach(() => {
		mockProcessManager = new ProcessManager()
		strategy = new MetroDevServerStrategy(mockProcessManager, 5000, 100)
	})

	describe('isRunning', () => {
		it('should return true when ProcessManager detects a process on the port', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue({
				pid: 12345,
				name: 'node',
				command: 'npx react-native start',
				port,
				isDevServer: true,
			})

			const result = await strategy.isRunning(port)

			expect(result).toBe(true)
			expect(mockProcessManager.detectDevServer).toHaveBeenCalledWith(port)
		})

		it('should return false when no process detected', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			const result = await strategy.isRunning(port)

			expect(result).toBe(false)
		})
	})

	describe('startBackground', () => {
		it('should start Metro with npx react-native start --port PORT', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'npx react-native start',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground(mockWorktreePath, port)

			expect(execa).toHaveBeenCalledWith(
				'npx',
				['react-native', 'start', '--port', '3087'],
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

		it('should set env PORT and pass worktreePath as cwd', async () => {
			const port = 4000

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'npx react-native start',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground('/custom/worktree', port)

			expect(execa).toHaveBeenCalledWith(
				'npx',
				expect.any(Array),
				expect.objectContaining({
					cwd: '/custom/worktree',
					env: expect.objectContaining({
						PORT: '4000',
					}),
				})
			)
		})

		it('should throw when Metro fails to start within timeout', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			// Server never starts
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			// Short timeout strategy
			const shortTimeoutStrategy = new MetroDevServerStrategy(mockProcessManager, 500, 100)

			await expect(shortTimeoutStrategy.startBackground(mockWorktreePath, port)).rejects.toThrow(
				'Metro bundler failed to start within 500ms timeout'
			)
		})

		it('should forward envOverrides to the process', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'npx react-native start',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await strategy.startBackground(mockWorktreePath, port, { API_URL: 'http://localhost:3000' })

			expect(execa).toHaveBeenCalledWith(
				'npx',
				expect.any(Array),
				expect.objectContaining({
					env: expect.objectContaining({
						API_URL: 'http://localhost:3000',
						PORT: '3087',
					}),
				})
			)
		})

		it('should handle early process exit (crash detection)', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
				exitCode: 1, // Process already exited
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await expect(strategy.startBackground(mockWorktreePath, port)).rejects.toThrow(
				'Metro bundler failed to start within 5000ms timeout'
			)
		})
	})

	describe('startForeground', () => {
		it('should start Metro in foreground with inherited stdio', async () => {
			const port = 3087

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			const result = await strategy.startForeground(mockWorktreePath, port, {})

			expect(execa).toHaveBeenCalledWith(
				'npx',
				['react-native', 'start', '--port', '3087'],
				expect.objectContaining({
					cwd: mockWorktreePath,
					env: expect.objectContaining({
						PORT: '3087',
					}),
					stdio: ['inherit', 'inherit', 'inherit'],
				})
			)
			expect(result).toEqual({ pid: 12345 })
		})

		it('should redirect to stderr when redirectToStderr is true', async () => {
			const port = 3087

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
			})

			expect(execa).toHaveBeenCalledWith(
				'npx',
				expect.any(Array),
				expect.objectContaining({
					stdio: [process.stdin, process.stderr, process.stderr],
				})
			)
		})

		it('should call onProcessStarted callback with PID', async () => {
			const port = 3087
			const onProcessStarted = vi.fn()

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await strategy.startForeground(mockWorktreePath, port, {
				onProcessStarted,
			})

			expect(onProcessStarted).toHaveBeenCalledWith(12345)
		})

		it('should pipe stdout/stderr to onOutput callback when provided', async () => {
			const port = 3087
			const onOutput = vi.fn()
			const mockStdout = { on: vi.fn() }
			const mockStderr = { on: vi.fn() }

			const mockProcess = {
				pid: 12345,
				stdout: mockStdout,
				stderr: mockStderr,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await strategy.startForeground(mockWorktreePath, port, { onOutput })

			expect(execa).toHaveBeenCalledWith(
				'npx',
				expect.any(Array),
				expect.objectContaining({
					stdio: ['ignore', 'pipe', 'pipe'],
				})
			)
			expect(mockStdout.on).toHaveBeenCalledWith('data', onOutput)
			expect(mockStderr.on).toHaveBeenCalledWith('data', onOutput)
		})
	})

	describe('stop', () => {
		it('should kill tracked Metro process and return true', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'npx react-native start',
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

		it('should return false when no Metro process is tracked for the port', async () => {
			const port = 3087

			const result = await strategy.stop(port)

			expect(result).toBe(false)
		})

		it('should kill process group (negative PID) for detached processes', async () => {
			const port = 3087

			const mockProcess = {
				pid: 54321,
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 54321,
					name: 'node',
					command: 'npx react-native start',
					port,
					isDevServer: true,
				})

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

			await strategy.startBackground(mockWorktreePath, port)

			const result = await strategy.stop(port)

			expect(result).toBe(true)
			expect(processKillSpy).toHaveBeenCalledWith(-54321, 'SIGTERM')

			processKillSpy.mockRestore()
		})
	})

	describe('stopAll', () => {
		it('should stop all tracked Metro processes', async () => {
			const port = 3087

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				catch: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'npx react-native start',
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
					command: 'npx react-native start',
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

			const shortTimeoutStrategy = new MetroDevServerStrategy(mockProcessManager, 500, 100)
			const result = await shortTimeoutStrategy.waitForReady(port)

			expect(result).toBe(false)
		})

		it('should return false early when process exits before becoming ready', async () => {
			const port = 3087

			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const mockProcess = {
				exitCode: 1,
			} as unknown as ExecaChildProcess

			const result = await strategy.waitForReady(port, mockProcess)

			expect(result).toBe(false)
		})
	})
})
