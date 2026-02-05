import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DevServerManager } from './DevServerManager.js'
import { ProcessManager } from './process/ProcessManager.js'
import { execa, type ExecaChildProcess } from 'execa'
import { setTimeout } from 'timers/promises'
import * as devServerUtils from '../utils/dev-server.js'
import * as packageManagerUtils from '../utils/package-manager.js'
import * as packageJsonUtils from '../utils/package-json.js'
import * as ngShimUtils from '../utils/ng-shim.js'

// Mock dependencies
vi.mock('execa')
vi.mock('timers/promises')
vi.mock('./process/ProcessManager.js')
vi.mock('../utils/dev-server.js', async (importOriginal) => {
	const actual = await importOriginal<typeof devServerUtils>()
	return {
		...actual,
		buildDevServerCommand: vi.fn(),
		detectAngularProject: vi.fn(),
	}
})
vi.mock('../utils/package-manager.js')
vi.mock('../utils/package-json.js')
vi.mock('../utils/ng-shim.js')

// Mock the logger
vi.mock('../utils/logger.js', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}))

describe('DevServerManager', () => {
	let manager: DevServerManager
	let mockProcessManager: ProcessManager
	const mockWorktreePath = '/test/worktrees/issue-87'

	beforeEach(() => {
		mockProcessManager = new ProcessManager()
		manager = new DevServerManager(mockProcessManager, {
			startupTimeout: 5000,
			checkInterval: 100,
		})

		// Reset all mocks
		vi.clearAllMocks()

		// Default: mock getPackageScripts to return scripts with dev script
		vi.mocked(packageJsonUtils.getPackageScripts).mockResolvedValue({
			dev: { command: 'pnpm dev', source: 'package-manager' },
		})

		// Default: mock detectAngularProject to return false (not Angular project)
		vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(false)
	})

	afterEach(async () => {
		await manager.cleanup()
	})

	describe('ensureServerRunning', () => {
		it('should return true if server is already running', async () => {
			const port = 3087

			// Mock server already running
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue({
				pid: 12345,
				name: 'node',
				command: 'pnpm dev',
				port,
				isDevServer: true,
			})

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(true)
			expect(mockProcessManager.detectDevServer).toHaveBeenCalledWith(port)
			// Should not try to start server
			expect(devServerUtils.buildDevServerCommand).not.toHaveBeenCalled()
		})

		it('should start server and wait for it to be ready if not running', async () => {
			const port = 3087

			// Mock server not running initially, then running after start
			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null) // Initial check: not running
				.mockResolvedValueOnce(null) // First poll: still not ready
				.mockResolvedValueOnce({
					// Second poll: ready!
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			// Mock dev command builder
			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			// Mock execa to return a process-like object
			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			// Mock setTimeout (used for polling)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(true)
			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath, {
				port,
			})
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

		it('should return false if server fails to start within timeout', async () => {
			const port = 3087

			// Mock server never starts
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			// Mock dev command builder
			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			// Mock execa
			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			// Mock setTimeout - advance time artificially
			vi.mocked(setTimeout).mockImplementation(async () => {
				return undefined
			})

			// Override timeout to make test faster
			manager = new DevServerManager(mockProcessManager, {
				startupTimeout: 500, // Short timeout for test
				checkInterval: 100,
			})

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(false)
			// Should have tried to start
			expect(execa).toHaveBeenCalled()
		})

		it('should handle errors when starting dev server', async () => {
			const port = 3087

			// Mock server not running
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			// Mock dev command builder throws error
			vi.mocked(devServerUtils.buildDevServerCommand).mockRejectedValue(
				new Error('Command build failed')
			)

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(false)
		})

		it('should set PORT environment variable when starting server', async () => {
			const port = 3087

			// Mock server not running, then running
			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await manager.ensureServerRunning(mockWorktreePath, port)

			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087',
					}),
				})
			)
		})

		it('should run server in background with detached process', async () => {
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

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await manager.ensureServerRunning(mockWorktreePath, port)

			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					stdio: 'ignore',
					detached: true,
				})
			)
			expect(mockProcess.unref).toHaveBeenCalled()
		})

		it('should skip server start and return true if no dev script exists', async () => {
			const port = 3087

			// Mock server not running
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			// Mock no dev script (only build script exists)
			vi.mocked(packageJsonUtils.getPackageScripts).mockResolvedValue({
				build: { command: 'tsc', source: 'package-manager' },
			})

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			// Should return true (graceful skip - auto-start is convenience feature)
			expect(result).toBe(true)
			// Should not attempt to build command or execute
			expect(devServerUtils.buildDevServerCommand).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		})

		it('should skip server start and return true if no package files exist', async () => {
			const port = 3087

			// Mock server not running
			vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue(null)

			// Mock no scripts at all (neither package.json nor package.iloom.json)
			vi.mocked(packageJsonUtils.getPackageScripts).mockResolvedValue({})

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			// Should return true (graceful skip - auto-start is convenience feature)
			expect(result).toBe(true)
			// Should not attempt to build command or execute
			expect(devServerUtils.buildDevServerCommand).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		})
	})

	describe('waitForServerReady', () => {
		it('should poll port until server is detected', async () => {
			const port = 3087

			// Server becomes ready on 3rd check
			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(true)
			// Should have checked port multiple times (1 initial + 3 during wait)
			expect(mockProcessManager.detectDevServer).toHaveBeenCalledTimes(4)
		})

		it('should respect custom check interval', async () => {
			const port = 3087
			const checkInterval = 250

			manager = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval,
			})

			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await manager.ensureServerRunning(mockWorktreePath, port)

			// Verify setTimeout was called with correct interval
			expect(setTimeout).toHaveBeenCalledWith(checkInterval)
		})
	})

	describe('runServerForeground', () => {
		it('should use runScript for non-redirect mode', async () => {
			const port = 3087
			const onStart = vi.fn()

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			const result = await manager.runServerForeground(
				mockWorktreePath,
				port,
				false,
				onStart,
				{ DATABASE_URL: 'postgres://test' }
			)

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
					onStart,
					noCi: true,
				})
			)
			expect(result).toEqual({ pid: 12345 })
		})

		it('should use buildDevServerCommand for redirectToStderr mode', async () => {
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

			await manager.runServerForeground(
				mockWorktreePath,
				port,
				true,  // redirectToStderr = true
				undefined,
				{ DATABASE_URL: 'postgres://test', CUSTOM_VAR: 'value' }
			)

			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath, {
				port,
			})
			expect(execa).toHaveBeenCalledWith(
				'sh',
				['-c', 'pnpm dev'],
				expect.objectContaining({
					env: expect.objectContaining({
						DATABASE_URL: 'postgres://test',
						CUSTOM_VAR: 'value',
						PORT: '3087',
					}),
					stdio: [process.stdin, process.stderr, process.stderr],
				})
			)
			expect(packageManagerUtils.runScript).not.toHaveBeenCalled()
		})

		it('should let PORT parameter override envOverrides.PORT', async () => {
			const port = 3087

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await manager.runServerForeground(
				mockWorktreePath,
				port,
				false,
				undefined,
				{ PORT: '9999' } // Should be overridden
			)

			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087', // Function param wins
					}),
				})
			)
		})

		it('should work with empty envOverrides', async () => {
			const port = 3087

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await manager.runServerForeground(
				mockWorktreePath,
				port,
				false,
				undefined,
				{}
			)

			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087',
					}),
				})
			)
		})

		it('should work without envOverrides (undefined)', async () => {
			const port = 3087

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await manager.runServerForeground(mockWorktreePath, port, false, undefined)

			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087',
					}),
				})
			)
		})

		it('should call onProcessStarted callback in redirectToStderr mode', async () => {
			const port = 3087
			const onStart = vi.fn()

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await manager.runServerForeground(
				mockWorktreePath,
				port,
				true,  // redirectToStderr
				onStart
			)

			expect(onStart).toHaveBeenCalledWith(12345)
		})
	})

	describe('cleanup', () => {
		it('should kill all running server processes', async () => {
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

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await manager.ensureServerRunning(mockWorktreePath, port)

			// Now cleanup
			await manager.cleanup()

			expect(mockProcess.kill).toHaveBeenCalled()
		})

		it('should handle errors during cleanup gracefully', async () => {
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

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(() => {
					throw new Error('Kill failed')
				}),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await manager.ensureServerRunning(mockWorktreePath, port)

			// Cleanup should not throw
			await expect(manager.cleanup()).resolves.not.toThrow()
		})
	})

	describe('default options', () => {
		it('should use default timeout (180s) and interval if not specified', () => {
			const defaultManager = new DevServerManager()

			// Access private options through type assertion for testing
			const options = (defaultManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

			expect(options.startupTimeout).toBe(180000) // 180 seconds
			expect(options.checkInterval).toBe(1000)
		})

		it('should allow partial options override', () => {
			const customManager = new DevServerManager(undefined, {
				startupTimeout: 15000,
			})

			const options = (customManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

			expect(options.startupTimeout).toBe(15000)
			expect(options.checkInterval).toBe(1000) // Default
		})

		it('should use ILOOM_DEV_SERVER_TIMEOUT env var when set', () => {
			const originalEnv = process.env.ILOOM_DEV_SERVER_TIMEOUT
			try {
				process.env.ILOOM_DEV_SERVER_TIMEOUT = '60000'
				const envManager = new DevServerManager()
				const options = (envManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

				expect(options.startupTimeout).toBe(60000)
			} finally {
				if (originalEnv === undefined) {
					delete process.env.ILOOM_DEV_SERVER_TIMEOUT
				} else {
					process.env.ILOOM_DEV_SERVER_TIMEOUT = originalEnv
				}
			}
		})

		it('should ignore invalid ILOOM_DEV_SERVER_TIMEOUT values and use default', () => {
			const originalEnv = process.env.ILOOM_DEV_SERVER_TIMEOUT
			try {
				process.env.ILOOM_DEV_SERVER_TIMEOUT = 'invalid'
				const envManager = new DevServerManager()
				const options = (envManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

				expect(options.startupTimeout).toBe(180000) // Default
			} finally {
				if (originalEnv === undefined) {
					delete process.env.ILOOM_DEV_SERVER_TIMEOUT
				} else {
					process.env.ILOOM_DEV_SERVER_TIMEOUT = originalEnv
				}
			}
		})

		it('should ignore negative ILOOM_DEV_SERVER_TIMEOUT values and use default', () => {
			const originalEnv = process.env.ILOOM_DEV_SERVER_TIMEOUT
			try {
				process.env.ILOOM_DEV_SERVER_TIMEOUT = '-5000'
				const envManager = new DevServerManager()
				const options = (envManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

				expect(options.startupTimeout).toBe(180000) // Default
			} finally {
				if (originalEnv === undefined) {
					delete process.env.ILOOM_DEV_SERVER_TIMEOUT
				} else {
					process.env.ILOOM_DEV_SERVER_TIMEOUT = originalEnv
				}
			}
		})

		it('should prefer explicit startupTimeout option over env var', () => {
			const originalEnv = process.env.ILOOM_DEV_SERVER_TIMEOUT
			try {
				process.env.ILOOM_DEV_SERVER_TIMEOUT = '60000'
				const customManager = new DevServerManager(undefined, {
					startupTimeout: 30000,
				})
				const options = (customManager as { options: Required<{ startupTimeout: number; checkInterval: number }> }).options

				expect(options.startupTimeout).toBe(30000) // Explicit option wins
			} finally {
				if (originalEnv === undefined) {
					delete process.env.ILOOM_DEV_SERVER_TIMEOUT
				} else {
					process.env.ILOOM_DEV_SERVER_TIMEOUT = originalEnv
				}
			}
		})
	})

	describe('portFlag support', () => {
		it('should pass portFlag to buildDevServerCommand in startDevServer', async () => {
			const port = 3087

			// Create manager with portFlag option
			const managerWithPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
				portFlag: '--port',
			})

			// Mock server not running, then running
			vi.mocked(mockProcessManager.detectDevServer)
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev -- --port=3087')

			const mockProcess = {
				unref: vi.fn(),
				kill: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			vi.mocked(setTimeout).mockResolvedValue(undefined)

			await managerWithPortFlag.ensureServerRunning(mockWorktreePath, port)

			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath, {
				port,
				portFlag: '--port',
			})

			await managerWithPortFlag.cleanup()
		})

		it('should pass portFlag to buildDevServerCommand in runServerForeground redirectToStderr mode', async () => {
			const port = 3087

			// Create manager with portFlag option
			const managerWithPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
				portFlag: '--port',
			})

			vi.mocked(devServerUtils.buildDevServerCommand).mockResolvedValue('pnpm dev -- --port=3087')

			const mockProcess = {
				pid: 12345,
				then: (resolve: (value: unknown) => void) => {
					resolve(undefined)
					return mockProcess
				},
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			await managerWithPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				true  // redirectToStderr = true
			)

			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath, {
				port,
				portFlag: '--port',
			})

			await managerWithPortFlag.cleanup()
		})

		it('should pass portFlag args to runScript in runServerForeground normal mode', async () => {
			const port = 3087

			// Create manager with portFlag option
			const managerWithPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
				portFlag: '--port',
			})

			// Mock Angular detection to return false (not Angular project)
			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(false)

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await managerWithPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false  // redirectToStderr = false
			)

			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				['--', '--port=3087'],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087',
					}),
					foreground: true,
					noCi: true,
				})
			)

			await managerWithPortFlag.cleanup()
		})

		it('should use PATH shim for Angular projects when no explicit portFlag', async () => {
			const port = 4200
			const mockShimDir = '/tmp/iloom-ng-shim-abc123'
			const mockCleanup = vi.fn().mockResolvedValue(undefined)

			// Create manager without portFlag option
			const managerNoPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
			})

			// Mock Angular detection to return true
			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(true)

			// Mock ng shim creation
			vi.mocked(ngShimUtils.createNgShim).mockResolvedValue({
				shimDir: mockShimDir,
				cleanup: mockCleanup,
			})

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await managerNoPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false
			)

			// Should create the ng shim
			expect(ngShimUtils.createNgShim).toHaveBeenCalledWith(port, mockWorktreePath)

			// Should pass empty args (no -- --port=X) and include shim env vars
			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[], // No port flag args - shim handles it
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '4200',
						PATH: expect.stringContaining(mockShimDir),
						ILOOM_WORKSPACE_PATH: mockWorktreePath,
						ILOOM_TARGET_PORT: '4200',
					}),
				})
			)

			// Should cleanup the shim after process exits
			expect(mockCleanup).toHaveBeenCalled()

			await managerNoPortFlag.cleanup()
		})

		it('should prefer explicit portFlag over Angular PATH shim', async () => {
			const port = 4200

			// Create manager with custom portFlag
			const managerWithCustomPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
				portFlag: '-p',
			})

			// Mock Angular detection to return true (would use PATH shim if no explicit flag)
			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(true)

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await managerWithCustomPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false
			)

			// Should NOT create the ng shim when explicit portFlag is set
			expect(ngShimUtils.createNgShim).not.toHaveBeenCalled()

			// Should use explicit -p via args, not PATH shim
			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				['--', '-p=4200'],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '4200',
					}),
				})
			)

			await managerWithCustomPortFlag.cleanup()
		})

		it('should not add port flag args when neither explicit portFlag nor Angular project', async () => {
			const port = 3087

			// Create manager without portFlag option
			const managerNoPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
			})

			// Mock Angular detection to return false
			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(false)

			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await managerNoPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false
			)

			// Should pass empty args array (no port flag)
			expect(packageManagerUtils.runScript).toHaveBeenCalledWith(
				'dev',
				mockWorktreePath,
				[],
				expect.objectContaining({
					env: expect.objectContaining({
						PORT: '3087',
					}),
				})
			)

			// Should NOT create ng shim for non-Angular projects
			expect(ngShimUtils.createNgShim).not.toHaveBeenCalled()

			await managerNoPortFlag.cleanup()
		})

		it('should cleanup ng shim even if runScript throws', async () => {
			const port = 4200
			const mockShimDir = '/tmp/iloom-ng-shim-abc123'
			const mockCleanup = vi.fn().mockResolvedValue(undefined)

			const managerNoPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
			})

			// Mock Angular detection to return true
			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(true)

			// Mock ng shim creation
			vi.mocked(ngShimUtils.createNgShim).mockResolvedValue({
				shimDir: mockShimDir,
				cleanup: mockCleanup,
			})

			// Mock runScript to throw an error
			vi.mocked(packageManagerUtils.runScript).mockRejectedValue(new Error('Process failed'))

			await expect(managerNoPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false
			)).rejects.toThrow('Process failed')

			// Cleanup should still be called
			expect(mockCleanup).toHaveBeenCalled()

			await managerNoPortFlag.cleanup()
		})

		it('should prepend shim directory to existing PATH', async () => {
			const port = 4200
			const mockShimDir = '/tmp/iloom-ng-shim-abc123'
			const mockCleanup = vi.fn().mockResolvedValue(undefined)
			const originalPath = process.env.PATH

			const managerNoPortFlag = new DevServerManager(mockProcessManager, {
				startupTimeout: 5000,
				checkInterval: 100,
			})

			vi.mocked(devServerUtils.detectAngularProject).mockResolvedValue(true)
			vi.mocked(ngShimUtils.createNgShim).mockResolvedValue({
				shimDir: mockShimDir,
				cleanup: mockCleanup,
			})
			vi.mocked(packageManagerUtils.runScript).mockResolvedValue({ pid: 12345 })

			await managerNoPortFlag.runServerForeground(
				mockWorktreePath,
				port,
				false
			)

			// PATH should start with shim dir followed by original PATH
			const callEnv = vi.mocked(packageManagerUtils.runScript).mock.calls[0][3]?.env
			expect(callEnv?.PATH).toMatch(new RegExp(`^${mockShimDir}:`))
			if (originalPath) {
				expect(callEnv?.PATH).toContain(originalPath)
			}

			await managerNoPortFlag.cleanup()
		})
	})
})
