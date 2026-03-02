import { describe, it, expect, vi } from 'vitest'
import { DockerManager } from './DockerManager.js'
import { execa } from 'execa'
import { readFile } from 'fs/promises'

// Mock dependencies
vi.mock('execa')
vi.mock('fs/promises')

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

describe('DockerManager', () => {
	describe('isAvailable', () => {
		it('should return true when docker CLI is accessible', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '',
				stderr: '',
			} as never)

			const result = await DockerManager.isAvailable()

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith('docker', ['info'], { reject: false })
		})

		it('should return false when docker CLI is not found', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: 'Cannot connect to the Docker daemon',
			} as never)

			const result = await DockerManager.isAvailable()

			expect(result).toBe(false)
		})

		it('should return false when execa throws', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('command not found: docker'))

			const result = await DockerManager.isAvailable()

			expect(result).toBe(false)
		})
	})

	describe('assertAvailable', () => {
		it('should not throw when Docker is available', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '',
				stderr: '',
			} as never)

			await expect(DockerManager.assertAvailable()).resolves.toBeUndefined()
		})

		it('should throw with install instructions when Docker is not installed', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 1,
				stdout: '',
				stderr: '',
			} as never)

			await expect(DockerManager.assertAvailable()).rejects.toThrow(
				'Docker is not installed'
			)
			await expect(DockerManager.assertAvailable()).rejects.toThrow(
				'https://docs.docker.com/get-docker/'
			)
		})
	})

	describe('buildImage', () => {
		it('should build with default Dockerfile path', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await DockerManager.buildImage('/test/worktree', 'my-image', './Dockerfile')

			expect(execa).toHaveBeenCalledWith(
				'docker',
				['build', '-t', 'my-image', '-f', './Dockerfile', '.'],
				{ cwd: '/test/worktree', stdio: 'inherit' }
			)
		})

		it('should build with custom Dockerfile path', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await DockerManager.buildImage('/test/worktree', 'my-image', './docker/Dockerfile.dev')

			expect(execa).toHaveBeenCalledWith(
				'docker',
				['build', '-t', 'my-image', '-f', './docker/Dockerfile.dev', '.'],
				{ cwd: '/test/worktree', stdio: 'inherit' }
			)
		})

		it('should pass build args when configured', async () => {
			vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)

			await DockerManager.buildImage(
				'/test/worktree',
				'my-image',
				'./Dockerfile',
				{ NODE_ENV: 'development', API_URL: 'http://localhost:3000' }
			)

			expect(execa).toHaveBeenCalledWith(
				'docker',
				[
					'build', '-t', 'my-image', '-f', './Dockerfile',
					'--build-arg', 'NODE_ENV=development',
					'--build-arg', 'API_URL=http://localhost:3000',
					'.',
				],
				{ cwd: '/test/worktree', stdio: 'inherit' }
			)
		})

		it('should throw on build failure with clear error message', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Step 3/7 : RUN npm install\n---> Running in abc123\nnpm ERR! code E404'))

			await expect(
				DockerManager.buildImage('/test/worktree', 'my-image', './Dockerfile')
			).rejects.toThrow('Docker build failed for image "my-image"')
		})
	})

	describe('runDetached', () => {
		it('should run with port mapping -p hostPort:containerPort', async () => {
			// First call: force-remove existing container (reject: false)
			// Second call: docker run
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123def456' } as never) // run -d

			const containerId = await DockerManager.runDetached(
				'my-image', 'iloom-dev-123', 3123, 4200
			)

			expect(containerId).toBe('abc123def456')
			// First call: force-remove
			expect(execa).toHaveBeenNthCalledWith(1, 'docker', ['rm', '-f', 'iloom-dev-123'], { reject: false })
			// Second call: run
			expect(execa).toHaveBeenNthCalledWith(2, 'docker', [
				'run', '-d',
				'--name', 'iloom-dev-123',
				'-p', '3123:4200',
				'my-image',
			])
		})

		it('should pass additional dockerRunArgs', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123' } as never) // run

			await DockerManager.runDetached(
				'my-image', 'iloom-dev-123', 3123, 4200,
				['-v', './src:/app/src', '--env', 'DEBUG=true']
			)

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', [
				'run', '-d',
				'--name', 'iloom-dev-123',
				'-p', '3123:4200',
				'-v', './src:/app/src', '--env', 'DEBUG=true',
				'my-image',
			])
		})

		it('should use named container iloom-dev-{identifier}', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0, stdout: 'containerid' } as never) // run

			await DockerManager.runDetached(
				'my-image', 'iloom-dev-548', 3548, 4200
			)

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', expect.arrayContaining([
				'--name', 'iloom-dev-548',
			]))
		})

		it('should throw on run failure with error details', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockRejectedValueOnce(new Error('port already allocated'))

			await expect(
				DockerManager.runDetached('my-image', 'iloom-dev-123', 3123, 4200)
			).rejects.toThrow('Failed to start Docker container "iloom-dev-123"')
		})
	})

	describe('runForeground', () => {
		it('should run attached with --rm flag and port mapping', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0 } as never) // run (foreground)

			await DockerManager.runForeground(
				'my-image', 'iloom-dev-123', 3123, 4200
			)

			// First call: force-remove
			expect(execa).toHaveBeenNthCalledWith(1, 'docker', ['rm', '-f', 'iloom-dev-123'], { reject: false })
			// Second call: run in foreground
			expect(execa).toHaveBeenNthCalledWith(2, 'docker', [
				'run',
				'--name', 'iloom-dev-123',
				'--rm',
				'-p', '3123:4200',
				'my-image',
			], { stdio: 'inherit' })
		})

		it('should redirect to stderr when redirectToStderr is true', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0 } as never) // run

			await DockerManager.runForeground(
				'my-image', 'iloom-dev-123', 3123, 4200,
				undefined, true
			)

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', expect.any(Array), {
				stdio: [process.stdin, process.stderr, process.stderr],
			})
		})

		it('should pass additional args', async () => {
			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0 } as never) // run

			await DockerManager.runForeground(
				'my-image', 'iloom-dev-123', 3123, 4200,
				['-v', './src:/app/src']
			)

			expect(execa).toHaveBeenNthCalledWith(2, 'docker', [
				'run',
				'--name', 'iloom-dev-123',
				'--rm',
				'-p', '3123:4200',
				'-v', './src:/app/src',
				'my-image',
			], { stdio: 'inherit' })
		})

		it('should set up signal forwarding for SIGINT and SIGTERM', async () => {
			const processOnSpy = vi.spyOn(process, 'on')
			const processRemoveListenerSpy = vi.spyOn(process, 'removeListener')

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockResolvedValueOnce({ exitCode: 0 } as never) // run

			await DockerManager.runForeground(
				'my-image', 'iloom-dev-123', 3123, 4200
			)

			// Should have registered signal handlers
			expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))

			// Should have cleaned up signal handlers
			expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})

		it('should clean up signal handlers even when docker run fails', async () => {
			const processRemoveListenerSpy = vi.spyOn(process, 'removeListener')

			vi.mocked(execa)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // rm -f
				.mockRejectedValueOnce(new Error('container failed')) // run

			await expect(
				DockerManager.runForeground('my-image', 'iloom-dev-123', 3123, 4200)
			).rejects.toThrow('container failed')

			// Signal handlers should still be cleaned up
			expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
			expect(processRemoveListenerSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
		})
	})

	describe('stopAndRemoveContainer', () => {
		it('should force-remove a running container', async () => {
			// isContainerRunning check
			vi.mocked(execa)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: 'iloom-dev-123',
				} as never) // docker ps
				.mockResolvedValueOnce({ exitCode: 0 } as never) // docker rm -f

			const result = await DockerManager.stopAndRemoveContainer('iloom-dev-123')

			expect(result).toBe(true)
			// Should have used docker rm -f (atomic force-remove)
			expect(execa).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', 'iloom-dev-123'], { reject: false })
		})

		it('should not throw if container does not exist', async () => {
			// isContainerRunning returns false
			vi.mocked(execa)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: '',
				} as never) // docker ps (empty = not running)
				.mockResolvedValueOnce({ exitCode: 1 } as never) // docker rm -f (not found, ok)

			const result = await DockerManager.stopAndRemoveContainer('iloom-dev-nonexistent')

			expect(result).toBe(false)
		})

		it('should still try rm -f for stopped containers', async () => {
			// isContainerRunning returns false (container stopped but exists)
			vi.mocked(execa)
				.mockResolvedValueOnce({
					exitCode: 0,
					stdout: '',
				} as never) // docker ps (not running)
				.mockResolvedValueOnce({ exitCode: 0 } as never) // docker rm -f (removes stopped container)

			const result = await DockerManager.stopAndRemoveContainer('iloom-dev-stopped')

			expect(result).toBe(false)
			expect(execa).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', 'iloom-dev-stopped'], { reject: false })
		})
	})

	describe('isContainerRunning', () => {
		it('should return true for running named container', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'iloom-dev-123',
			} as never)

			const result = await DockerManager.isContainerRunning('iloom-dev-123')

			expect(result).toBe(true)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				['ps', '--filter', 'name=^iloom-dev-123$', '--format', '{{.Names}}'],
				{ reject: false }
			)
		})

		it('should return false for stopped/missing container', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '',
			} as never)

			const result = await DockerManager.isContainerRunning('iloom-dev-missing')

			expect(result).toBe(false)
		})

		it('should return false when docker ps fails', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 1,
				stdout: '',
			} as never)

			const result = await DockerManager.isContainerRunning('iloom-dev-123')

			expect(result).toBe(false)
		})

		it('should return false when execa throws', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

			const result = await DockerManager.isContainerRunning('iloom-dev-123')

			expect(result).toBe(false)
		})

		it('should use exact name matching with anchored regex', async () => {
			// Ensure "iloom-dev-1" doesn't match "iloom-dev-123"
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'iloom-dev-123', // returned name does not match queried name
			} as never)

			const result = await DockerManager.isContainerRunning('iloom-dev-1')

			expect(result).toBe(false) // Names don't match
		})
	})

	describe('parseExposeFromDockerfile', () => {
		it('should extract port from EXPOSE directive', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nWORKDIR /app\nCOPY . .\nEXPOSE 4200\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBe(4200)
		})

		it('should return last EXPOSE if multiple exist (handles multi-stage builds)', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nEXPOSE 4200\nEXPOSE 8080\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBe(8080)
		})

		it('should return null if no EXPOSE directive', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nWORKDIR /app\nCOPY . .\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBeNull()
		})

		it('should handle EXPOSE with protocol (e.g., 4200/tcp)', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nEXPOSE 4200/tcp\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBe(4200)
		})

		it('should handle EXPOSE with udp protocol', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nEXPOSE 8080/udp\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBe(8080)
		})

		it('should return null if Dockerfile does not exist', async () => {
			vi.mocked(readFile).mockRejectedValue(
				Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
			)

			const port = await DockerManager.parseExposeFromDockerfile('/nonexistent/Dockerfile')

			expect(port).toBeNull()
		})

		it('should not match EXPOSE in comments', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\n# EXPOSE 4200\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.parseExposeFromDockerfile('/test/Dockerfile')

			expect(port).toBeNull()
		})
	})

	describe('inspectImagePorts', () => {
		it('should detect ports from docker image inspect', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '{"4200/tcp":{}}',
			} as never)

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBe(4200)
			expect(execa).toHaveBeenCalledWith(
				'docker',
				['image', 'inspect', 'my-image', '--format', '{{json .Config.ExposedPorts}}'],
				{ reject: false }
			)
		})

		it('should return first port when multiple are exposed', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '{"4200/tcp":{},"8080/tcp":{}}',
			} as never)

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBe(4200)
		})

		it('should return null when no ports are exposed', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'null',
			} as never)

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBeNull()
		})

		it('should return null for empty exposed ports', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '{}',
			} as never)

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBeNull()
		})

		it('should return null when inspect fails', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 1,
				stdout: '',
			} as never)

			const port = await DockerManager.inspectImagePorts('nonexistent-image')

			expect(port).toBeNull()
		})

		it('should return null for <nil> output', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '<nil>',
			} as never)

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBeNull()
		})

		it('should handle execa throwing', async () => {
			vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

			const port = await DockerManager.inspectImagePorts('my-image')

			expect(port).toBeNull()
		})
	})

	describe('resolveContainerPort', () => {
		it('should return config port when provided', async () => {
			const port = await DockerManager.resolveContainerPort(4200, '/test/Dockerfile')

			expect(port).toBe(4200)
			// Should not call execa or readFile since config port is provided
			expect(execa).not.toHaveBeenCalled()
			expect(readFile).not.toHaveBeenCalled()
		})

		it('should use image inspect when config port is not set and imageName provided', async () => {
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: '{"8080/tcp":{}}',
			} as never)

			const port = await DockerManager.resolveContainerPort(
				undefined, '/test/Dockerfile', 'my-image'
			)

			expect(port).toBe(8080)
		})

		it('should fall back to Dockerfile regex when image inspect returns nothing', async () => {
			// Image inspect returns null
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'null',
			} as never)

			// Dockerfile has EXPOSE
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nEXPOSE 3000\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.resolveContainerPort(
				undefined, '/test/Dockerfile', 'my-image'
			)

			expect(port).toBe(3000)
		})

		it('should use Dockerfile regex when no imageName provided', async () => {
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nEXPOSE 4200\nCMD ["npm", "start"]'
			)

			const port = await DockerManager.resolveContainerPort(undefined, '/test/Dockerfile')

			expect(port).toBe(4200)
		})

		it('should throw when no port source provides a port', async () => {
			// Image inspect returns null
			vi.mocked(execa).mockResolvedValue({
				exitCode: 0,
				stdout: 'null',
			} as never)

			// Dockerfile has no EXPOSE
			vi.mocked(readFile).mockResolvedValue(
				'FROM node:18\nCMD ["npm", "start"]'
			)

			await expect(
				DockerManager.resolveContainerPort(undefined, '/test/Dockerfile', 'my-image')
			).rejects.toThrow('Cannot determine container port')
		})

		it('should include helpful error message with resolution steps', async () => {
			vi.mocked(readFile).mockResolvedValue('FROM node:18\nCMD ["npm", "start"]')

			await expect(
				DockerManager.resolveContainerPort(undefined, '/test/Dockerfile')
			).rejects.toThrow('capabilities.web')
		})
	})

	describe('sanitizeContainerName', () => {
		it('should replace slashes with hyphens', () => {
			expect(DockerManager.sanitizeContainerName('feat/issue-548')).toBe('feat-issue-548')
		})

		it('should remove invalid characters', () => {
			expect(DockerManager.sanitizeContainerName('my@container!name')).toBe('my-container-name')
		})

		it('should handle branch names like feat/issue-548__docker', () => {
			// Double underscores are valid Docker container name characters
			expect(DockerManager.sanitizeContainerName('iloom-dev-feat/issue-548__docker'))
				.toBe('iloom-dev-feat-issue-548__docker')
		})

		it('should collapse consecutive hyphens', () => {
			expect(DockerManager.sanitizeContainerName('a---b---c')).toBe('a-b-c')
		})

		it('should remove leading non-alphanumeric characters', () => {
			expect(DockerManager.sanitizeContainerName('---my-container')).toBe('my-container')
		})

		it('should remove trailing hyphens', () => {
			expect(DockerManager.sanitizeContainerName('my-container---')).toBe('my-container')
		})

		it('should truncate to 63 characters', () => {
			const longName = 'a'.repeat(100)
			const result = DockerManager.sanitizeContainerName(longName)

			expect(result.length).toBeLessThanOrEqual(63)
		})

		it('should clean trailing hyphen after truncation', () => {
			// Create a name that will have a hyphen at position 63 after replacement
			const name = 'a'.repeat(62) + '/b'
			const result = DockerManager.sanitizeContainerName(name)

			expect(result).not.toMatch(/-$/)
			expect(result.length).toBeLessThanOrEqual(63)
		})

		it('should preserve dots and underscores', () => {
			expect(DockerManager.sanitizeContainerName('my_container.v1')).toBe('my_container.v1')
		})

		it('should handle empty string with fallback', () => {
			expect(DockerManager.sanitizeContainerName('---')).toBe('iloom-container')
		})

		it('should handle string with only invalid characters', () => {
			expect(DockerManager.sanitizeContainerName('@@@')).toBe('iloom-container')
		})

		it('should handle spaces in names', () => {
			expect(DockerManager.sanitizeContainerName('my container name')).toBe('my-container-name')
		})

		it('should preserve double underscores (valid Docker name chars)', () => {
			// Underscores are valid in Docker container names
			expect(DockerManager.sanitizeContainerName('feat__docker-server'))
				.toBe('feat__docker-server')
		})
	})

	describe('buildContainerName', () => {
		it('should build name with numeric identifier', () => {
			expect(DockerManager.buildContainerName(548)).toBe('iloom-dev-548')
		})

		it('should build name with string identifier', () => {
			expect(DockerManager.buildContainerName('my-branch')).toBe('iloom-dev-my-branch')
		})

		it('should sanitize branch names with slashes', () => {
			// Slashes replaced with hyphens, underscores preserved
			expect(DockerManager.buildContainerName('feat/issue-548__docker'))
				.toBe('iloom-dev-feat-issue-548__docker')
		})
	})

	describe('buildImageName', () => {
		it('should build image name with numeric identifier', () => {
			expect(DockerManager.buildImageName(548)).toBe('iloom-dev-548')
		})

		it('should build image name with string identifier', () => {
			expect(DockerManager.buildImageName('my-branch')).toBe('iloom-dev-my-branch')
		})
	})

	describe('buildDockerConfigFromSettings', () => {
		it('should return undefined when webSettings is undefined', () => {
			const result = DockerManager.buildDockerConfigFromSettings(undefined, '548')
			expect(result).toBeUndefined()
		})

		it('should return undefined when devServer is "process"', () => {
			const result = DockerManager.buildDockerConfigFromSettings(
				{ devServer: 'process' },
				'548'
			)
			expect(result).toBeUndefined()
		})

		it('should return undefined when devServer is not set', () => {
			const result = DockerManager.buildDockerConfigFromSettings({}, '548')
			expect(result).toBeUndefined()
		})

		it('should return DockerConfig when devServer is "docker"', () => {
			const result = DockerManager.buildDockerConfigFromSettings(
				{ devServer: 'docker' },
				'548'
			)

			expect(result).toEqual({
				dockerFile: './Dockerfile',
				containerPort: undefined,
				dockerBuildArgs: undefined,
				dockerRunArgs: undefined,
				identifier: '548',
			})
		})

		it('should use custom dockerFile when provided', () => {
			const result = DockerManager.buildDockerConfigFromSettings(
				{ devServer: 'docker', dockerFile: './docker/Dockerfile.dev' },
				'548'
			)

			expect(result?.dockerFile).toBe('./docker/Dockerfile.dev')
		})

		it('should pass through containerPort, buildArgs, and runArgs', () => {
			const result = DockerManager.buildDockerConfigFromSettings(
				{
					devServer: 'docker',
					containerPort: 4200,
					dockerBuildArgs: { NODE_ENV: 'development' },
					dockerRunArgs: ['-v', './src:/app/src'],
				},
				'my-branch'
			)

			expect(result).toEqual({
				dockerFile: './Dockerfile',
				containerPort: 4200,
				dockerBuildArgs: { NODE_ENV: 'development' },
				dockerRunArgs: ['-v', './src:/app/src'],
				identifier: 'my-branch',
			})
		})
	})
})
