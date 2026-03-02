import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DevServerManager, type DockerConfig } from './DevServerManager.js'
import { ProcessManager } from './process/ProcessManager.js'
import { DockerManager } from './DockerManager.js'
import { DockerDevServerStrategy } from './DockerDevServerStrategy.js'
import { execa, type ExecaChildProcess } from 'execa'
import { setTimeout } from 'timers/promises'
import * as devServerUtils from '../utils/dev-server.js'
import * as packageManagerUtils from '../utils/package-manager.js'
import * as packageJsonUtils from '../utils/package-json.js'

// Mock dependencies
vi.mock('execa')
vi.mock('timers/promises')
vi.mock('./process/ProcessManager.js')
vi.mock('./DockerManager.js')
vi.mock('./DockerDevServerStrategy.js')
vi.mock('../utils/dev-server.js')
vi.mock('../utils/package-manager.js')
vi.mock('../utils/package-json.js')

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
				on: vi.fn(),
			} as unknown as ExecaChildProcess
			vi.mocked(execa).mockReturnValue(mockProcess)

			// Mock setTimeout (used for polling)
			vi.mocked(setTimeout).mockResolvedValue(undefined)

			const result = await manager.ensureServerRunning(mockWorktreePath, port)

			expect(result).toBe(true)
			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath)
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
				on: vi.fn(),
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
				on: vi.fn(),
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
				on: vi.fn(),
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
				on: vi.fn(),
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
				on: vi.fn(),
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

			expect(devServerUtils.buildDevServerCommand).toHaveBeenCalledWith(mockWorktreePath)
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
				on: vi.fn(),
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

	describe('Docker mode', () => {
		const dockerConfig: DockerConfig = {
			dockerFile: './Dockerfile',
			containerPort: 4200,
			identifier: '548',
		}

		let mockStrategyInstance: {
			isContainerRunning: ReturnType<typeof vi.fn>
			buildImage: ReturnType<typeof vi.fn>
			resolveContainerPort: ReturnType<typeof vi.fn>
			runContainerDetached: ReturnType<typeof vi.fn>
			runContainerForeground: ReturnType<typeof vi.fn>
			stopContainer: ReturnType<typeof vi.fn>
			waitForReady: ReturnType<typeof vi.fn>
		}

		beforeEach(() => {
			// Set up default return values for DockerManager static methods (used by dockerUtils bridge)
			vi.mocked(DockerManager.buildContainerName).mockReturnValue('iloom-dev-548')
			vi.mocked(DockerManager.buildImageName).mockReturnValue('iloom-dev-548')

			// Set up the mock strategy instance returned by the mocked constructor
			mockStrategyInstance = {
				isContainerRunning: vi.fn(),
				buildImage: vi.fn(),
				resolveContainerPort: vi.fn(),
				runContainerDetached: vi.fn(),
				runContainerForeground: vi.fn(),
				stopContainer: vi.fn(),
				waitForReady: vi.fn(),
			}

			vi.mocked(DockerDevServerStrategy).mockImplementation(() => mockStrategyInstance as unknown as DockerDevServerStrategy)
		})

		describe('ensureServerRunning', () => {
			it('should detect running container and skip start', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(true)

				const result = await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				expect(result).toBe(true)
				expect(mockStrategyInstance.isContainerRunning).toHaveBeenCalledWith('iloom-dev-548')
				expect(mockStrategyInstance.buildImage).not.toHaveBeenCalled()
			})

			it('should build image then run container in background when not running', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerDetached.mockResolvedValue('iloom-dev-548')
				mockStrategyInstance.waitForReady.mockResolvedValue(true)

				const result = await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				expect(result).toBe(true)
				expect(mockStrategyInstance.buildImage).toHaveBeenCalledWith(
					mockWorktreePath,
					expect.objectContaining({
						dockerFile: './Dockerfile',
						containerPort: 4200,
					})
				)
				expect(mockStrategyInstance.resolveContainerPort).toHaveBeenCalledWith(
					expect.objectContaining({ containerPort: 4200 }),
					'iloom-dev-548',
					expect.stringContaining('Dockerfile')
				)
				expect(mockStrategyInstance.runContainerDetached).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					4200,
					expect.objectContaining({
						dockerFile: './Dockerfile',
						containerPort: 4200,
					})
				)
			})

			it('should return false when Docker build fails', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockRejectedValue(new Error('Build failed'))

				const result = await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				expect(result).toBe(false)
			})

			it('should clean up container and return false when server fails to start within timeout', async () => {
				const port = 3548

				manager = new DevServerManager(mockProcessManager, {
					startupTimeout: 500,
					checkInterval: 100,
				})

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerDetached.mockResolvedValue('iloom-dev-548')
				mockStrategyInstance.waitForReady.mockResolvedValue(false)
				mockStrategyInstance.stopContainer.mockResolvedValue(undefined)

				const result = await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				expect(result).toBe(false)
				// Should clean up the container on timeout
				expect(mockStrategyInstance.stopContainer).toHaveBeenCalledWith('iloom-dev-548')
			})

			it('should pass build args and run args to Docker', async () => {
				const port = 3548
				const configWithArgs: DockerConfig = {
					...dockerConfig,
					dockerBuildArgs: { NODE_ENV: 'development' },
					dockerRunArgs: ['-v', './src:/app/src'],
				}

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerDetached.mockResolvedValue('iloom-dev-548')
				mockStrategyInstance.waitForReady.mockResolvedValue(true)

				await manager.ensureServerRunning(mockWorktreePath, port, configWithArgs)

				expect(mockStrategyInstance.buildImage).toHaveBeenCalledWith(
					mockWorktreePath,
					expect.objectContaining({
						buildArgs: { NODE_ENV: 'development' },
					})
				)
				expect(mockStrategyInstance.runContainerDetached).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					4200,
					expect.objectContaining({
						runArgs: ['-v', './src:/app/src'],
					})
				)
			})

			it('should not use process-based detection in Docker mode', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(true)

				await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				// Process-based detection should NOT be called in Docker mode
				expect(mockProcessManager.detectDevServer).not.toHaveBeenCalled()
			})
		})

		describe('isServerRunning', () => {
			it('should check Docker container status when dockerConfig provided', async () => {
				const port = 3548
				mockStrategyInstance.isContainerRunning.mockResolvedValue(true)

				const result = await manager.isServerRunning(port, dockerConfig)

				expect(result).toBe(true)
				expect(DockerManager.buildContainerName).toHaveBeenCalledWith('548')
				expect(mockProcessManager.detectDevServer).not.toHaveBeenCalled()
			})

			it('should return false when Docker container is not running', async () => {
				const port = 3548
				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)

				const result = await manager.isServerRunning(port, dockerConfig)

				expect(result).toBe(false)
			})

			it('should fall back to process detection when no dockerConfig', async () => {
				const port = 3548
				vi.mocked(mockProcessManager.detectDevServer).mockResolvedValue({
					pid: 12345,
					name: 'node',
					command: 'pnpm dev',
					port,
					isDevServer: true,
				})

				const result = await manager.isServerRunning(port)

				expect(result).toBe(true)
				expect(mockProcessManager.detectDevServer).toHaveBeenCalledWith(port)
				expect(mockStrategyInstance.isContainerRunning).not.toHaveBeenCalled()
			})
		})

		describe('runServerForeground', () => {
			it('should build image then run container in foreground', async () => {
				const port = 3548

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				const result = await manager.runServerForeground(
					mockWorktreePath, port, false, undefined, undefined, dockerConfig
				)

				expect(result).toEqual({})
				expect(mockStrategyInstance.buildImage).toHaveBeenCalledWith(
					mockWorktreePath,
					expect.objectContaining({
						dockerFile: './Dockerfile',
						containerPort: 4200,
					})
				)
				expect(mockStrategyInstance.runContainerForeground).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					4200,
					expect.objectContaining({
						dockerFile: './Dockerfile',
						containerPort: 4200,
					}),
					expect.objectContaining({ redirectToStderr: false })
				)
			})

			it('should pass redirectToStderr to strategy.runContainerForeground', async () => {
				const port = 3548

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				await manager.runServerForeground(
					mockWorktreePath, port, true, undefined, undefined, dockerConfig
				)

				expect(mockStrategyInstance.runContainerForeground).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					4200,
					expect.anything(),
					expect.objectContaining({ redirectToStderr: true })
				)
			})

			it('should pass dockerRunArgs to container', async () => {
				const port = 3548
				const configWithRunArgs: DockerConfig = {
					...dockerConfig,
					dockerRunArgs: ['-v', './src:/app/src', '--env', 'DEBUG=true'],
				}

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				await manager.runServerForeground(
					mockWorktreePath, port, false, undefined, undefined, configWithRunArgs
				)

				expect(mockStrategyInstance.runContainerForeground).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					4200,
					expect.objectContaining({
						runArgs: ['-v', './src:/app/src', '--env', 'DEBUG=true'],
					}),
					expect.anything()
				)
			})

			it('should use containerPort from config or Dockerfile EXPOSE', async () => {
				const port = 3548
				const configWithoutPort: DockerConfig = {
					dockerFile: './Dockerfile',
					identifier: '548',
				}

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(8080)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				await manager.runServerForeground(
					mockWorktreePath, port, false, undefined, undefined, configWithoutPort
				)

				// resolveContainerPort should receive undefined for containerPort
				expect(mockStrategyInstance.resolveContainerPort).toHaveBeenCalledWith(
					expect.objectContaining({ containerPort: undefined }),
					'iloom-dev-548',
					expect.stringContaining('Dockerfile')
				)
				// runContainerForeground should use the resolved port
				expect(mockStrategyInstance.runContainerForeground).toHaveBeenCalledWith(
					mockWorktreePath,
					port,
					8080,
					expect.anything(),
					expect.anything()
				)
			})

			it('should call onProcessStarted with undefined pid in Docker mode', async () => {
				const port = 3548
				const onStart = vi.fn()

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				await manager.runServerForeground(
					mockWorktreePath, port, false, onStart, undefined, dockerConfig
				)

				// Docker containers don't have a host PID to report
				expect(onStart).toHaveBeenCalledWith(undefined)
			})

			it('should not use runScript or buildDevServerCommand in Docker mode', async () => {
				const port = 3548

				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerForeground.mockResolvedValue({})

				await manager.runServerForeground(
					mockWorktreePath, port, false, undefined, undefined, dockerConfig
				)

				expect(packageManagerUtils.runScript).not.toHaveBeenCalled()
				expect(devServerUtils.buildDevServerCommand).not.toHaveBeenCalled()
				expect(execa).not.toHaveBeenCalled()
			})
		})

		describe('cleanup', () => {
			it('should stop and remove tracked Docker containers', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerDetached.mockResolvedValue('iloom-dev-548')
				mockStrategyInstance.waitForReady.mockResolvedValue(true)

				await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				// Reset stopContainer mock to track cleanup call
				mockStrategyInstance.stopContainer.mockClear()
				mockStrategyInstance.stopContainer.mockResolvedValue(undefined)

				await manager.cleanup()

				expect(mockStrategyInstance.stopContainer).toHaveBeenCalledWith('iloom-dev-548')
			})

			it('should handle Docker cleanup errors gracefully', async () => {
				const port = 3548

				mockStrategyInstance.isContainerRunning.mockResolvedValue(false)
				mockStrategyInstance.buildImage.mockResolvedValue(undefined)
				mockStrategyInstance.resolveContainerPort.mockResolvedValue(4200)
				mockStrategyInstance.runContainerDetached.mockResolvedValue('iloom-dev-548')
				mockStrategyInstance.waitForReady.mockResolvedValue(true)

				await manager.ensureServerRunning(mockWorktreePath, port, dockerConfig)

				// Make cleanup fail
				mockStrategyInstance.stopContainer.mockRejectedValue(
					new Error('Docker daemon not responding')
				)

				// Should not throw
				await expect(manager.cleanup()).resolves.not.toThrow()
			})
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
})
