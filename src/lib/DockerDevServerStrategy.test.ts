import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import net from 'net'
import { DockerDevServerStrategy, type DockerConfig, type DockerUtils } from './DockerDevServerStrategy.js'
import { execa } from 'execa'
import { expandAndValidateSecretPaths } from '../utils/docker.js'

// Mock dependencies
vi.mock('execa')
vi.mock('net')
vi.mock('../utils/docker.js', () => ({
	expandAndValidateSecretPaths: vi.fn().mockReturnValue({}),
}))

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

const makeUtils = (overrides: Partial<DockerUtils> = {}): DockerUtils => ({
	parseDockerfileExpose: vi.fn().mockResolvedValue(null),
	inspectImagePorts: vi.fn().mockResolvedValue(null),
	buildContainerName: vi.fn().mockImplementation((id: string | number) => `iloom-dev-${id}`),
	buildImageName: vi.fn().mockImplementation((id: string | number) => `iloom-dev-${id}`),
	assertDockerAvailable: vi.fn().mockResolvedValue(undefined),
	...overrides,
})

const WORKTREE = '/worktrees/issue-742'

describe('DockerDevServerStrategy', () => {
	let config: DockerConfig
	let utils: DockerUtils
	let strategy: DockerDevServerStrategy

	beforeEach(() => {
		config = {
			dockerFile: './Dockerfile',
			containerPort: undefined,
			buildArgs: undefined,
			runArgs: undefined,
		}
		utils = makeUtils()
		strategy = new DockerDevServerStrategy(config, utils)
	})

	// ---------------------------------------------------------------------------
	// resolveContainerPort
	// ---------------------------------------------------------------------------
	describe('resolveContainerPort', () => {
		it('should return config.containerPort when explicitly set', async () => {
			const port = await strategy.resolveContainerPort(
				{ containerPort: 4200 },
				'my-image',
				'/path/Dockerfile'
			)

			expect(port).toBe(4200)
			// Should not attempt inspection or Dockerfile parsing
			expect(utils.inspectImagePorts).not.toHaveBeenCalled()
			expect(utils.parseDockerfileExpose).not.toHaveBeenCalled()
		})

		it('should use inspectImagePorts as second fallback when config port is absent', async () => {
			vi.mocked(utils.inspectImagePorts).mockResolvedValue(8080)

			const port = await strategy.resolveContainerPort({}, 'my-image', '/path/Dockerfile')

			expect(port).toBe(8080)
			expect(utils.inspectImagePorts).toHaveBeenCalledWith('my-image')
			expect(utils.parseDockerfileExpose).not.toHaveBeenCalled()
		})

		it('should fall back to parseDockerfileExpose when image inspect returns null', async () => {
			vi.mocked(utils.inspectImagePorts).mockResolvedValue(null)
			vi.mocked(utils.parseDockerfileExpose).mockResolvedValue(3000)

			const port = await strategy.resolveContainerPort({}, 'my-image', '/path/Dockerfile')

			expect(port).toBe(3000)
			expect(utils.inspectImagePorts).toHaveBeenCalledWith('my-image')
			expect(utils.parseDockerfileExpose).toHaveBeenCalledWith('/path/Dockerfile')
		})

		it('should throw a clear error when all three tiers return null', async () => {
			vi.mocked(utils.inspectImagePorts).mockResolvedValue(null)
			vi.mocked(utils.parseDockerfileExpose).mockResolvedValue(null)

			await expect(
				strategy.resolveContainerPort({}, 'my-image', '/path/Dockerfile')
			).rejects.toThrow(
				'Cannot determine container port. Set `devServer.docker.containerPort` in settings or add an `EXPOSE` directive to your Dockerfile.'
			)
		})
	})

	// ---------------------------------------------------------------------------
	// buildImage
	// ---------------------------------------------------------------------------
	describe('buildImage', () => {
		beforeEach(() => {
			vi.mocked(utils.buildImageName).mockReturnValue('iloom-dev-test')
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
			vi.mocked(expandAndValidateSecretPaths).mockReturnValue({})
		})

		it('should call docker build with correct flags', async () => {
			await strategy.buildImage(WORKTREE, { dockerFile: './Dockerfile' })

			expect(execa).toHaveBeenCalledWith(
				'docker',
				['build', '-t', 'iloom-dev-test', '-f', './Dockerfile', '.'],
				{ cwd: WORKTREE, stdio: 'inherit' }
			)
		})

		it('should default Dockerfile to ./Dockerfile when not set', async () => {
			await strategy.buildImage(WORKTREE, {})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['-f', './Dockerfile']),
				expect.any(Object)
			)
		})

		it('should pass buildArgs as --build-arg flags', async () => {
			await strategy.buildImage(WORKTREE, {
				dockerFile: './Dockerfile',
				buildArgs: { NODE_ENV: 'development', API_URL: 'http://localhost:3000' },
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'build', '-t', 'iloom-dev-test', '-f', './Dockerfile',
					'--build-arg', 'NODE_ENV=development',
					'--build-arg', 'API_URL=http://localhost:3000',
					'.',
				],
				{ cwd: WORKTREE, stdio: 'inherit' }
			)
		})

		it('should throw when docker build exits with non-zero code', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('npm install failed'))

			await expect(
				strategy.buildImage(WORKTREE, { dockerFile: './Dockerfile' })
			).rejects.toThrow('Docker build failed for image "iloom-dev-test"')
		})

		it('should pass buildSecrets as --secret flags', async () => {
			vi.mocked(expandAndValidateSecretPaths).mockReturnValue({
				npmrc: '/home/user/.npmrc',
			})

			await strategy.buildImage(WORKTREE, {
				dockerFile: './Dockerfile',
				buildSecrets: { npmrc: '~/.npmrc' },
			})

			expect(expandAndValidateSecretPaths).toHaveBeenCalledWith(
				{ npmrc: '~/.npmrc' },
				WORKTREE
			)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'build', '-t', 'iloom-dev-test', '-f', './Dockerfile',
					'--secret', 'id=npmrc,src=/home/user/.npmrc',
					'.',
				],
				expect.objectContaining({
					cwd: WORKTREE,
					stdio: 'inherit',
					env: expect.objectContaining({ DOCKER_BUILDKIT: '1' }),
				})
			)
		})

		it('should handle multiple secrets', async () => {
			vi.mocked(expandAndValidateSecretPaths).mockReturnValue({
				npmrc: '/home/user/.npmrc',
				dockerconfig: '/home/user/.docker/config.json',
			})

			await strategy.buildImage(WORKTREE, {
				dockerFile: './Dockerfile',
				buildSecrets: {
					npmrc: '~/.npmrc',
					dockerconfig: '~/.docker/config.json',
				},
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'build', '-t', 'iloom-dev-test', '-f', './Dockerfile',
					'--secret', 'id=npmrc,src=/home/user/.npmrc',
					'--secret', 'id=dockerconfig,src=/home/user/.docker/config.json',
					'.',
				],
				expect.objectContaining({
					cwd: WORKTREE,
					stdio: 'inherit',
					env: expect.objectContaining({ DOCKER_BUILDKIT: '1' }),
				})
			)
		})

		it('should not add --secret flags when buildSecrets is undefined', async () => {
			await strategy.buildImage(WORKTREE, { dockerFile: './Dockerfile' })

			expect(expandAndValidateSecretPaths).toHaveBeenCalledWith(undefined, WORKTREE)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				['build', '-t', 'iloom-dev-test', '-f', './Dockerfile', '.'],
				{ cwd: WORKTREE, stdio: 'inherit' }
			)
		})

		it('should set DOCKER_BUILDKIT=1 env when secrets are present', async () => {
			vi.mocked(expandAndValidateSecretPaths).mockReturnValue({
				npmrc: '/home/user/.npmrc',
			})

			await strategy.buildImage(WORKTREE, {
				dockerFile: './Dockerfile',
				buildSecrets: { npmrc: '~/.npmrc' },
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['--secret', 'id=npmrc,src=/home/user/.npmrc']),
				expect.objectContaining({
					cwd: WORKTREE,
					stdio: 'inherit',
					env: expect.objectContaining({ DOCKER_BUILDKIT: '1' }),
				})
			)
		})

		it('should not set DOCKER_BUILDKIT env when no secrets are present', async () => {
			vi.mocked(expandAndValidateSecretPaths).mockReturnValue({})

			await strategy.buildImage(WORKTREE, { dockerFile: './Dockerfile' })

			expect(execa).toHaveBeenCalledWith(
				'docker',
				['build', '-t', 'iloom-dev-test', '-f', './Dockerfile', '.'],
				{ cwd: WORKTREE, stdio: 'inherit' }
			)
		})
	})

	// ---------------------------------------------------------------------------
	// runContainerDetached
	// ---------------------------------------------------------------------------
	describe('runContainerDetached', () => {
		beforeEach(() => {
			vi.mocked(utils.buildImageName).mockReturnValue('iloom-dev-test')
			vi.mocked(utils.buildContainerName).mockReturnValue('iloom-dev-test')
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123' } as never) // docker run
		})

		it('should force-remove existing container before running', async () => {
			await strategy.runContainerDetached(WORKTREE, 3742, 4200, config)

			expect(execa).toHaveBeenNthCalledWith(
				1,
				'docker', ['rm', '-f', 'iloom-dev-test'], { reject: false }
			)
		})

		it('should run detached with correct port mapping and volume mounts', async () => {
			await strategy.runContainerDetached(WORKTREE, 3742, 4200, config)

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', [
				'run', '-d',
				'--name', 'iloom-dev-test',
				'-p', '3742:4200',
				'-v', `${WORKTREE}:/app`,
				'-v', '/app/node_modules',
				'-e', 'PORT=4200',
				'iloom-dev-test',
			])
		})

		it('should forward envOverrides as -e flags', async () => {
			await strategy.runContainerDetached(WORKTREE, 3742, 4200, config, {
				DATABASE_URL: 'postgres://localhost/test',
				DEBUG: 'true',
			})

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', expect.arrayContaining([
				'-e', 'DATABASE_URL=postgres://localhost/test',
				'-e', 'DEBUG=true',
			]))
		})

		it('should append runArgs to docker run command', async () => {
			await strategy.runContainerDetached(WORKTREE, 3742, 4200, {
				...config,
				runArgs: ['--memory', '512m', '--cpus', '0.5'],
			})

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', expect.arrayContaining([
				'--memory', '512m', '--cpus', '0.5',
			]))
		})

		it('should return container name', async () => {
			const name = await strategy.runContainerDetached(WORKTREE, 3742, 4200, config)

			expect(name).toBe('iloom-dev-test')
		})

		it('should throw when docker run fails', async () => {
			vi.mocked(execa)
				.mockReset()
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockRejectedValueOnce(new Error('port already allocated'))

			await expect(
				strategy.runContainerDetached(WORKTREE, 3742, 4200, config)
			).rejects.toThrow('Failed to start Docker container "iloom-dev-test"')
		})
	})

	// ---------------------------------------------------------------------------
	// runContainerForeground
	// ---------------------------------------------------------------------------
	describe('runContainerForeground', () => {
		const setupExeca = () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
		}

		/** Helper to create an ExecaError-like object with exitCode and/or signal */
		const makeExecaError = (props: { exitCode?: number; signal?: string; message?: string }): Error => {
			const err = new Error(props.message ?? `Command failed with exit code ${props.exitCode ?? 1}`)
			Object.assign(err, {
				exitCode: props.exitCode,
				signal: props.signal,
			})
			return err
		}

		beforeEach(() => {
			vi.mocked(utils.buildImageName).mockReturnValue('iloom-dev-test')
			vi.mocked(utils.buildContainerName).mockReturnValue('iloom-dev-test')
			setupExeca()
		})

		it('should run with --rm flag (auto-remove on exit)', async () => {
			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config)

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['--rm']),
				expect.any(Object)
			)
		})

		it('should include port mapping, worktree mount, and node_modules volume', async () => {
			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config)

			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'run', '--rm',
					'--name', 'iloom-dev-test',
					'-p', '3742:4200',
					'-v', `${WORKTREE}:/app`,
					'-v', '/app/node_modules',
					'-e', 'PORT=4200',
					'iloom-dev-test',
				],
				{ stdio: 'inherit' }
			)
		})

		it('should use stderr stdio when redirectToStderr is true', async () => {
			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config, {
				redirectToStderr: true,
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.any(Array),
				{ stdio: [process.stdin, process.stderr, process.stderr] }
			)
		})

		it('should forward envOverrides into the container', async () => {
			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config, {
				envOverrides: { DATABASE_URL: 'postgres://test' },
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['-e', 'DATABASE_URL=postgres://test']),
				expect.any(Object)
			)
		})

		it('should call onProcessStarted with undefined (no host PID for containers)', async () => {
			const onStart = vi.fn()

			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config, {
				onProcessStarted: onStart,
			})

			expect(onStart).toHaveBeenCalledWith(undefined)
		})

		it('should set up SIGINT and SIGTERM signal handlers', async () => {
			const onSpy = vi.spyOn(process, 'on')

			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config)

			expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should remove signal handlers after completion', async () => {
			const removeSpy = vi.spyOn(process, 'removeListener')

			await strategy.runContainerForeground(WORKTREE, 3742, 4200, config)

			expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should remove signal handlers even when docker run throws', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(new Error('container crashed'))
			const removeSpy = vi.spyOn(process, 'removeListener')

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).rejects.toThrow('container crashed')

			expect(removeSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(removeSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should silently swallow exit code 143 (SIGTERM via docker stop)', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(makeExecaError({ exitCode: 143 }))

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).resolves.toEqual({})
		})

		it('should silently swallow exit code 130 (SIGINT)', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(makeExecaError({ exitCode: 130 }))

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).resolves.toEqual({})
		})

		it('should silently swallow signal SIGTERM', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(makeExecaError({ signal: 'SIGTERM' }))

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).resolves.toEqual({})
		})

		it('should silently swallow signal SIGINT', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(makeExecaError({ signal: 'SIGINT' }))

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).resolves.toEqual({})
		})

		it('should re-throw unexpected errors (non-signal exit codes)', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({} as never) // rm -f (stale cleanup)
				.mockRejectedValueOnce(makeExecaError({ exitCode: 1, message: 'container failed' }))

			await expect(
				strategy.runContainerForeground(WORKTREE, 3742, 4200, config)
			).rejects.toThrow('container failed')
		})

		it('should return empty object (no host PID)', async () => {
			const result = await strategy.runContainerForeground(WORKTREE, 3742, 4200, config)

			expect(result).toEqual({})
		})

		it('should append config.runArgs to the docker run command', async () => {
			await strategy.runContainerForeground(WORKTREE, 3742, 4200, {
				...config,
				runArgs: ['--memory', '256m'],
			})

			expect(execa).toHaveBeenCalledWith(
				'docker',
				expect.arrayContaining(['--memory', '256m']),
				expect.any(Object)
			)
		})
	})

	// ---------------------------------------------------------------------------
	// stopContainer
	// ---------------------------------------------------------------------------
	describe('stopContainer', () => {
		it('should call docker rm -f with reject: false', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await strategy.stopContainer('iloom-dev-742')

			expect(execa).toHaveBeenCalledWith(
				'docker', ['rm', '-f', 'iloom-dev-742'], { reject: false }
			)
		})

		it('should not throw when container does not exist', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 1, stderr: 'No such container' } as never)

			await expect(strategy.stopContainer('iloom-dev-nonexistent')).resolves.toBeUndefined()
		})

		it('should not throw when container is already stopped', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 1 } as never)

			await expect(strategy.stopContainer('iloom-dev-stopped')).resolves.toBeUndefined()
		})
	})

	// ---------------------------------------------------------------------------
	// isContainerRunning
	// ---------------------------------------------------------------------------
	describe('isContainerRunning', () => {
		it('should return true when container is running', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'iloom-dev-742',
			} as never)

			const result = await strategy.isContainerRunning('iloom-dev-742')

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				['ps', '--filter', 'name=^iloom-dev-742$', '--format', '{{.Names}}'],
				{ reject: false }
			)
		})

		it('should return false when docker ps output is empty', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '' } as never)

			const result = await strategy.isContainerRunning('iloom-dev-742')

			expect(result).toBe(false)
		})

		it('should return false when docker ps exits with non-zero code', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '' } as never)

			const result = await strategy.isContainerRunning('iloom-dev-742')

			expect(result).toBe(false)
		})

		it('should return false when execa throws', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

			const result = await strategy.isContainerRunning('iloom-dev-742')

			expect(result).toBe(false)
		})

		it('should use exact name matching (does not match longer names)', async () => {
			// docker ps returns a different container name
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'iloom-dev-7420',
			} as never)

			const result = await strategy.isContainerRunning('iloom-dev-742')

			// Names differ, should be false
			expect(result).toBe(false)
		})
	})

	// ---------------------------------------------------------------------------
	// waitForReady
	// ---------------------------------------------------------------------------
	describe('waitForReady', () => {
		beforeEach(() => {
			// We need to replace global setTimeout to control timing
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('should return true when port accepts connections immediately', async () => {
			const mockSocket = {
				once: vi.fn().mockImplementation((event: string, cb: () => void) => {
					if (event === 'connect') {
						cb()
					}
					return mockSocket
				}),
				destroy: vi.fn(),
			}
			vi.mocked(net.createConnection).mockReturnValue(mockSocket as never)

			const promise = strategy.waitForReady(3742, 5000, 100)
			// Advance timers to let async operations complete
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(true)
		})

		it('should return false when timeout expires before port is available', async () => {
			const mockSocket = {
				once: vi.fn().mockImplementation((event: string, cb: () => void) => {
					if (event === 'error') {
						cb()
					}
					return mockSocket
				}),
				destroy: vi.fn(),
			}
			vi.mocked(net.createConnection).mockReturnValue(mockSocket as never)

			const promise = strategy.waitForReady(3742, 200, 50)
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(false)
		})

		it('should poll repeatedly until timeout', async () => {
			let callCount = 0
			const mockSocket = {
				once: vi.fn().mockImplementation((event: string, cb: () => void) => {
					if (event === 'error') {
						callCount++
						cb()
					}
					return mockSocket
				}),
				destroy: vi.fn(),
			}
			vi.mocked(net.createConnection).mockReturnValue(mockSocket as never)

			const promise = strategy.waitForReady(3742, 300, 100)
			await vi.runAllTimersAsync()

			await promise
			// Should have probed multiple times
			expect(callCount).toBeGreaterThan(1)
		})

		it('should return true as soon as port becomes available', async () => {
			let attempt = 0
			const mockSocket = {
				once: vi.fn().mockImplementation((event: string, cb: () => void) => {
					attempt++
					// First two attempts fail, third succeeds
					if (attempt < 3 && event === 'error') {
						cb()
					} else if (attempt >= 3 && event === 'connect') {
						cb()
					}
					return mockSocket
				}),
				destroy: vi.fn(),
			}
			vi.mocked(net.createConnection).mockReturnValue(mockSocket as never)

			const promise = strategy.waitForReady(3742, 5000, 50)
			await vi.runAllTimersAsync()

			const result = await promise
			expect(result).toBe(true)
		})
	})
})
