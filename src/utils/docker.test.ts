import { statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, vi } from 'vitest'
import { execa } from 'execa'
import { readFile } from 'fs/promises'
import {
	isDockerInstalled,
	isDockerRunning,
	assertDockerAvailable,
	parseDockerfileExpose,
	inspectImagePorts,
	sanitizeContainerName,
	buildContainerName,
	buildImageName,
	expandAndValidateSecretPaths,
} from './docker.js'

vi.mock('execa')
vi.mock('fs/promises')
vi.mock('node:fs', () => ({
	statSync: vi.fn(),
}))

describe('isDockerInstalled', () => {
	it('should return true when docker --version succeeds', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: 'Docker version 24.0.0, build abc123',
			stderr: '',
		} as never)

		const result = await isDockerInstalled()

		expect(result).toBe(true)
		expect(execa).toHaveBeenCalledWith('docker', ['--version'], { reject: false })
	})

	it('should return false when docker --version fails (non-zero exit)', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: '',
		} as never)

		const result = await isDockerInstalled()

		expect(result).toBe(false)
	})

	it('should return false when execa throws (command not found)', async () => {
		vi.mocked(execa).mockRejectedValue(new Error('command not found: docker'))

		const result = await isDockerInstalled()

		expect(result).toBe(false)
	})
})

describe('isDockerRunning', () => {
	it('should return true when docker info succeeds', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: 'Containers: 2',
			stderr: '',
		} as never)

		const result = await isDockerRunning()

		expect(result).toBe(true)
		expect(execa).toHaveBeenCalledWith('docker', ['info'], { reject: false })
	})

	it('should return false when docker info fails (daemon not running)', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: 'Cannot connect to the Docker daemon',
		} as never)

		const result = await isDockerRunning()

		expect(result).toBe(false)
	})

	it('should return false when execa throws', async () => {
		vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

		const result = await isDockerRunning()

		expect(result).toBe(false)
	})
})

describe('assertDockerAvailable', () => {
	it('should not throw when Docker is installed and running', async () => {
		// First call: isDockerInstalled (docker --version)
		// Second call: isDockerRunning (docker info)
		vi.mocked(execa)
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' } as never)

		await expect(assertDockerAvailable()).resolves.toBeUndefined()
	})

	it('should throw with install instructions when Docker is not installed', async () => {
		vi.mocked(execa).mockResolvedValueOnce({
			exitCode: 1,
			stdout: '',
			stderr: '',
		} as never)

		await expect(assertDockerAvailable()).rejects.toThrow('Docker is not installed')
		await expect(
			(async () => {
				vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1 } as never)
				await assertDockerAvailable()
			})()
		).rejects.toThrow('https://docs.docker.com/get-docker/')
	})

	it('should throw with daemon instructions when installed but not running', async () => {
		// isDockerInstalled succeeds
		vi.mocked(execa)
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'Docker version 24.0.0' } as never)
			// isDockerRunning fails
			.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never)

		await expect(assertDockerAvailable()).rejects.toThrow('Docker daemon is not running')
	})

	it('should include actionable start instructions in daemon error', async () => {
		vi.mocked(execa)
			.mockResolvedValueOnce({ exitCode: 0 } as never)
			.mockResolvedValueOnce({ exitCode: 1 } as never)

		await expect(assertDockerAvailable()).rejects.toThrow('Docker Desktop')
	})
})

describe('parseDockerfileExpose', () => {
	it('should extract port from simple EXPOSE directive', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\nWORKDIR /app\nCOPY . .\nEXPOSE 4200\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBe(4200)
	})

	it('should handle EXPOSE with protocol suffix (4200/tcp)', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\nEXPOSE 4200/tcp\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBe(4200)
	})

	it('should handle EXPOSE with udp protocol', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\nEXPOSE 8080/udp\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBe(8080)
	})

	it('should return null when no EXPOSE directive', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\nWORKDIR /app\nCOPY . .\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBeNull()
	})

	it('should ignore comment lines (# EXPOSE 4200)', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\n# EXPOSE 4200\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBeNull()
	})

	it('should use LAST EXPOSE in multi-stage builds', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18 AS builder\nEXPOSE 3000\n\nFROM node:18-alpine\nEXPOSE 4200\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBe(4200)
	})

	it('should use last EXPOSE when multiple EXPOSE directives exist', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'FROM node:18\nEXPOSE 3000\nEXPOSE 8080\nEXPOSE 4200\nCMD ["npm", "start"]'
		)

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBe(4200)
	})

	it('should return null when file does not exist', async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
		)

		const port = await parseDockerfileExpose('/nonexistent/Dockerfile')

		expect(port).toBeNull()
	})

	it('should validate port range (reject port 0 and above 65535)', async () => {
		vi.mocked(readFile).mockResolvedValue('FROM node:18\nEXPOSE 99999\nCMD ["node", "app.js"]')

		const port = await parseDockerfileExpose('/test/Dockerfile')

		expect(port).toBeNull()
	})
})

describe('inspectImagePorts', () => {
	it('should detect port from docker image inspect JSON', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: '{"4200/tcp":{}}',
		} as never)

		const port = await inspectImagePorts('my-image')

		expect(port).toBe(4200)
		expect(execa).toHaveBeenCalledWith(
			'docker',
			['image', 'inspect', 'my-image', '--format', '{{json .Config.ExposedPorts}}'],
			{ reject: false }
		)
	})

	it('should return first port from multi-port image', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: '{"4200/tcp":{},"8080/tcp":{}}',
		} as never)

		const port = await inspectImagePorts('my-image')

		expect(port).toBe(4200)
	})

	it('should return null for "null" output', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: 'null',
		} as never)

		const port = await inspectImagePorts('my-image')

		expect(port).toBeNull()
	})

	it('should return null for "<nil>" output', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: '<nil>',
		} as never)

		const port = await inspectImagePorts('my-image')

		expect(port).toBeNull()
	})

	it('should return null for "{}" output (empty ports)', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 0,
			stdout: '{}',
		} as never)

		const port = await inspectImagePorts('my-image')

		expect(port).toBeNull()
	})

	it('should return null when inspect fails (non-zero exit)', async () => {
		vi.mocked(execa).mockResolvedValue({
			exitCode: 1,
			stdout: '',
		} as never)

		const port = await inspectImagePorts('nonexistent-image')

		expect(port).toBeNull()
	})

	it('should return null when execa throws', async () => {
		vi.mocked(execa).mockRejectedValue(new Error('Docker not available'))

		const port = await inspectImagePorts('my-image')

		expect(port).toBeNull()
	})
})

describe('sanitizeContainerName', () => {
	it('should replace slashes with hyphens', () => {
		expect(sanitizeContainerName('feat/issue-548')).toBe('feat-issue-548')
	})

	it('should remove invalid characters', () => {
		expect(sanitizeContainerName('my@container!name')).toBe('my-container-name')
	})

	it('should collapse consecutive hyphens', () => {
		expect(sanitizeContainerName('a---b---c')).toBe('a-b-c')
	})

	it('should remove leading non-alphanumeric characters', () => {
		expect(sanitizeContainerName('---my-container')).toBe('my-container')
	})

	it('should remove trailing hyphens', () => {
		expect(sanitizeContainerName('my-container---')).toBe('my-container')
	})

	it('should truncate to 63 characters', () => {
		const longName = 'a'.repeat(100)
		const result = sanitizeContainerName(longName)

		expect(result.length).toBeLessThanOrEqual(63)
	})

	it('should clean trailing hyphen after truncation', () => {
		// Create a name that will have a hyphen at position 63 after replacement
		const name = 'a'.repeat(62) + '/b'
		const result = sanitizeContainerName(name)

		expect(result).not.toMatch(/-$/)
		expect(result.length).toBeLessThanOrEqual(63)
	})

	it('should preserve dots and underscores', () => {
		expect(sanitizeContainerName('my_container.v1')).toBe('my_container.v1')
	})

	it('should handle empty/all-invalid string with fallback', () => {
		expect(sanitizeContainerName('---')).toBe('iloom-container')
		expect(sanitizeContainerName('@@@')).toBe('iloom-container')
	})

	it('should handle spaces in names', () => {
		expect(sanitizeContainerName('my container name')).toBe('my-container-name')
	})

	it('should handle branch names with special characters', () => {
		expect(sanitizeContainerName('iloom-dev-feat/issue-548__docker'))
			.toBe('iloom-dev-feat-issue-548__docker')
	})

	it('should handle numeric identifiers', () => {
		expect(sanitizeContainerName(548)).toBe('548')
	})

	it('should preserve double underscores (valid Docker name chars)', () => {
		expect(sanitizeContainerName('feat__docker-server')).toBe('feat__docker-server')
	})
})

describe('buildContainerName', () => {
	it('should return "iloom-dev-{id}" for numeric identifier', () => {
		expect(buildContainerName(548)).toBe('iloom-dev-548')
	})

	it('should return "iloom-dev-{sanitized}" for string identifier', () => {
		expect(buildContainerName('my-branch')).toBe('iloom-dev-my-branch')
	})

	it('should sanitize branch names with slashes', () => {
		expect(buildContainerName('feat/issue-548__docker'))
			.toBe('iloom-dev-feat-issue-548__docker')
	})
})

describe('buildImageName', () => {
	it('should return "iloom-dev-{id}" for numeric identifier', () => {
		expect(buildImageName(548)).toBe('iloom-dev-548')
	})

	it('should return "iloom-dev-{sanitized}" for string identifier', () => {
		expect(buildImageName('my-branch')).toBe('iloom-dev-my-branch')
	})

	it('should sanitize branch names with slashes', () => {
		expect(buildImageName('feat/issue-548'))
			.toBe('iloom-dev-feat-issue-548')
	})
})

describe('expandAndValidateSecretPaths', () => {
	const mockFileStats = () => {
		vi.mocked(statSync).mockReturnValue({ isFile: () => true } as never)
	}

	it('should return empty record for undefined input', () => {
		const result = expandAndValidateSecretPaths(undefined, '/test/cwd')
		expect(result).toEqual({})
	})

	it('should return empty record for empty input', () => {
		const result = expandAndValidateSecretPaths({}, '/test/cwd')
		expect(result).toEqual({})
	})

	it('should expand ~ to homedir in source paths', () => {
		mockFileStats()

		const result = expandAndValidateSecretPaths(
			{ npmrc: '~/.npmrc' },
			'/test/cwd'
		)

		expect(result.npmrc).toBe(path.join(os.homedir(), '.npmrc'))
	})

	it('should resolve relative paths against provided cwd', () => {
		mockFileStats()

		const result = expandAndValidateSecretPaths(
			{ config: 'secrets/config.json' },
			'/test/worktree'
		)

		expect(result.config).toBe(path.resolve('/test/worktree', 'secrets/config.json'))
	})

	it('should leave absolute paths unchanged', () => {
		mockFileStats()

		const result = expandAndValidateSecretPaths(
			{ cert: '/etc/ssl/cert.pem' },
			'/test/cwd'
		)

		expect(result.cert).toBe('/etc/ssl/cert.pem')
	})

	it('should throw when source file does not exist', () => {
		vi.mocked(statSync).mockImplementation(() => {
			throw new Error('ENOENT: no such file or directory')
		})

		expect(() =>
			expandAndValidateSecretPaths(
				{ npmrc: '~/.npmrc' },
				'/test/cwd'
			)
		).toThrow('Secret source file not found')
	})

	it('should include the secret ID and missing path in error message', () => {
		vi.mocked(statSync).mockImplementation(() => {
			throw new Error('ENOENT: no such file or directory')
		})

		expect(() =>
			expandAndValidateSecretPaths(
				{ mytoken: '/nonexistent/token.txt' },
				'/test/cwd'
			)
		).toThrow('"mytoken"')
		expect(() =>
			expandAndValidateSecretPaths(
				{ mytoken: '/nonexistent/token.txt' },
				'/test/cwd'
			)
		).toThrow('/nonexistent/token.txt')
	})

	it('should handle multiple secrets, expanding each independently', () => {
		mockFileStats()

		const result = expandAndValidateSecretPaths(
			{
				npmrc: '~/.npmrc',
				cert: '/etc/ssl/cert.pem',
				local: 'secrets/local.env',
			},
			'/test/worktree'
		)

		expect(result.npmrc).toBe(path.join(os.homedir(), '.npmrc'))
		expect(result.cert).toBe('/etc/ssl/cert.pem')
		expect(result.local).toBe(path.resolve('/test/worktree', 'secrets/local.env'))
	})

	it('should throw when secret ID contains invalid characters', () => {
		expect(() =>
			expandAndValidateSecretPaths(
				{ 'my secret': '/path/to/file' },
				'/test/cwd'
			)
		).toThrow('Invalid secret ID "my secret"')

		expect(() =>
			expandAndValidateSecretPaths(
				{ 'id,injected=evil': '/path/to/file' },
				'/test/cwd'
			)
		).toThrow('Invalid secret ID "id,injected=evil"')

		expect(() =>
			expandAndValidateSecretPaths(
				{ 'id=bad': '/path/to/file' },
				'/test/cwd'
			)
		).toThrow('Invalid secret ID')
	})

	it('should accept valid secret IDs with alphanumeric, underscore, dot, and hyphen', () => {
		mockFileStats()

		const result = expandAndValidateSecretPaths(
			{
				'my-secret': '/path/to/file1',
				'my_secret': '/path/to/file2',
				'my.secret': '/path/to/file3',
				'mySecret123': '/path/to/file4',
			},
			'/test/cwd'
		)

		expect(Object.keys(result)).toHaveLength(4)
	})

	it('should throw when source path is a directory', () => {
		vi.mocked(statSync).mockReturnValue({ isFile: () => false } as never)

		expect(() =>
			expandAndValidateSecretPaths(
				{ config: '/etc/ssl' },
				'/test/cwd'
			)
		).toThrow('is a directory, not a file')
		expect(() =>
			expandAndValidateSecretPaths(
				{ config: '/etc/ssl' },
				'/test/cwd'
			)
		).toThrow('"config"')
	})

	it('should throw when resolved path contains a comma', () => {
		expect(() =>
			expandAndValidateSecretPaths(
				{ cert: '/path/with,comma/cert.pem' },
				'/test/cwd'
			)
		).toThrow('contains a comma')
		expect(() =>
			expandAndValidateSecretPaths(
				{ cert: '/path/with,comma/cert.pem' },
				'/test/cwd'
			)
		).toThrow('"cert"')
	})
})
