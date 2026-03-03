import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile } from 'fs/promises'
import fs from 'fs-extra'
import { parseComposeFile, generateOverrideFile } from './compose.js'
import type { ComposePortMapping } from './compose.js'

vi.mock('fs/promises')
vi.mock('fs-extra')

describe('parseComposeFile', () => {
	it('parses short syntax ports ("3000:3000")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000:3000"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
		])
	})

	it('parses short syntax with protocol ("3000:3000/tcp")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000:3000/tcp"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 3000, containerPort: 3000, protocol: 'tcp' },
		])
	})

	it('parses short syntax with udp protocol ("8080:80/udp")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "8080:80/udp"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 8080, containerPort: 80, protocol: 'udp' },
		])
	})

	it('parses host-only short syntax with different host and container ports ("8080:80")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "8080:80"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 8080, containerPort: 80 },
		])
	})

	it('parses IP-bound short syntax ("127.0.0.1:8080:80") and preserves hostIp', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'db', hostPort: 5432, containerPort: 5432, hostIp: '127.0.0.1' },
		])
	})

	it('parses IP-bound short syntax with protocol ("127.0.0.1:8080:80/tcp")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  db:\n    ports:\n      - "127.0.0.1:8080:80/tcp"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'db', hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '127.0.0.1' },
		])
	})

	it('parses long-form syntax (target/published)', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - target: 80\n        published: 8080\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 8080, containerPort: 80 },
		])
	})

	it('parses long-form with protocol', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - target: 80\n        published: 8080\n        protocol: udp\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 8080, containerPort: 80, protocol: 'udp' },
		])
	})

	it('parses long-form with host_ip and preserves it', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  db:\n    ports:\n      - target: 5432\n        published: 5432\n        host_ip: "127.0.0.1"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'db', hostPort: 5432, containerPort: 5432, hostIp: '127.0.0.1' },
		])
	})

	it('returns empty array for services with no ports', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  db:\n    image: postgres:15\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('returns empty array for compose file with no services key', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'version: "3.8"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('returns empty array for empty compose file', async () => {
		vi.mocked(readFile).mockResolvedValue('')

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('handles multiple services with ports', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000:3000"\n  api:\n    ports:\n      - "4000:4000"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toHaveLength(2)
		expect(result).toContainEqual({ service: 'web', hostPort: 3000, containerPort: 3000 })
		expect(result).toContainEqual({ service: 'api', hostPort: 4000, containerPort: 4000 })
	})

	it('handles service with multiple port mappings', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000:3000"\n      - "3001:3001"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toHaveLength(2)
		expect(result[0]).toEqual({ service: 'web', hostPort: 3000, containerPort: 3000 })
		expect(result[1]).toEqual({ service: 'web', hostPort: 3001, containerPort: 3001 })
	})

	it('skips container-only port entries (no host port)', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('skips port range entries ("8080-8081:8080-8081")', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "8080-8081:8080-8081"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('skips container-only port range entries', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "8080-8081"\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('skips long-form entries without published (host) port', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - target: 80\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([])
	})

	it('throws on file read error (file not found)', async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
		)

		await expect(parseComposeFile('/nonexistent/docker-compose.yml')).rejects.toThrow('ENOENT')
	})

	it('mixes services with and without ports', async () => {
		vi.mocked(readFile).mockResolvedValue(
			'services:\n  web:\n    ports:\n      - "3000:3000"\n  db:\n    image: postgres:15\n'
		)

		const result = await parseComposeFile('/project/docker-compose.yml')

		expect(result).toEqual([
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
		])
	})
})

describe('generateOverrideFile', () => {
	beforeEach(() => {
		vi.mocked(fs.ensureDir).mockResolvedValue(undefined as never)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined as never)
	})

	it('generates valid override YAML with offset ports (numeric identifier)', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
		]

		const result = await generateOverrideFile(mappings, 42, '/data/issue-42')

		// hostPort 3000 + identifier 42 = 3042
		expect(result).toBe('/data/issue-42/docker-compose.override.yml')
		expect(fs.ensureDir).toHaveBeenCalledWith('/data/issue-42')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		expect(writeCallArgs[0]).toBe('/data/issue-42/docker-compose.override.yml')
		const writtenContent = String(writeCallArgs[1])
		expect(writtenContent).toContain('3042:3000')
	})

	it('generates valid override YAML with offset ports (string identifier)', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
		]

		const result = await generateOverrideFile(mappings, '42', '/data/issue-42')

		expect(result).toBe('/data/issue-42/docker-compose.override.yml')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])
		expect(writtenContent).toContain('3042:3000')
	})

	it('throws for non-numeric string identifier', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
		]

		await expect(generateOverrideFile(mappings, 'issue-42', '/data')).rejects.toThrow(
			'Invalid identifier: "issue-42"'
		)
	})

	it('wraps ports exceeding 65535', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 65000, containerPort: 8080 },
		]

		// 65000 + 1000 = 66000, which exceeds 65535, should wrap
		const result = await generateOverrideFile(mappings, 1000, '/data/issue-1000')

		expect(result).toBe('/data/issue-1000/docker-compose.override.yml')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])

		// The wrapped port should be <= 65535 and in the valid range
		// wrapPort(66000, 65000): range = 65535 - 65000 = 535
		// ((66000 - 65000 - 1) % 535) + 65000 + 1 = (999 % 535) + 65001 = 464 + 65001 = 65465
		expect(writtenContent).toContain('65465:8080')
	})

	it('writes file to dataDir and returns path', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'api', hostPort: 4000, containerPort: 4000 },
		]

		const resultPath = await generateOverrideFile(mappings, 100, '/tmp/iloom/issue-100')

		expect(resultPath).toBe('/tmp/iloom/issue-100/docker-compose.override.yml')
		expect(fs.ensureDir).toHaveBeenCalledWith('/tmp/iloom/issue-100')
		expect(fs.writeFile).toHaveBeenCalledWith(
			'/tmp/iloom/issue-100/docker-compose.override.yml',
			expect.any(String),
			'utf-8'
		)
	})

	it('handles multiple services in override', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
			{ service: 'api', hostPort: 4000, containerPort: 4000 },
		]

		await generateOverrideFile(mappings, 42, '/data/issue-42')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])

		expect(writtenContent).toContain('3042:3000')
		expect(writtenContent).toContain('4042:4000')
	})

	it('preserves protocol in override port strings', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000, protocol: 'udp' },
		]

		await generateOverrideFile(mappings, 42, '/data/issue-42')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])

		expect(writtenContent).toContain('3042:3000/udp')
	})

	it('preserves hostIp in override to prevent port exposure on 0.0.0.0', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'db', hostPort: 5432, containerPort: 5432, hostIp: '127.0.0.1' },
		]

		await generateOverrideFile(mappings, 42, '/data/issue-42')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])

		// Should include the IP binding to keep the port local
		expect(writtenContent).toContain('127.0.0.1:5474:5432')
	})

	it('handles empty mappings array', async () => {
		const result = await generateOverrideFile([], 42, '/data/issue-42')

		expect(result).toBe('/data/issue-42/docker-compose.override.yml')
		expect(fs.ensureDir).toHaveBeenCalledWith('/data/issue-42')
		expect(fs.writeFile).toHaveBeenCalled()
	})

	it('handles multiple ports for the same service', async () => {
		const mappings: ComposePortMapping[] = [
			{ service: 'web', hostPort: 3000, containerPort: 3000 },
			{ service: 'web', hostPort: 3001, containerPort: 3001 },
		]

		await generateOverrideFile(mappings, 42, '/data/issue-42')

		const writeCallArgs = vi.mocked(fs.writeFile).mock.calls[0]
		const writtenContent = String(writeCallArgs[1])

		expect(writtenContent).toContain('3042:3000')
		expect(writtenContent).toContain('3043:3001')
	})
})
