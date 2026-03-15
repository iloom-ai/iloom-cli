import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildDevServerCommand, buildDevServerUrl, getDevServerLaunchCommand } from './dev-server.js'
import * as packageManager from './package-manager.js'

// Mock package-manager module
vi.mock('./package-manager.js', () => ({
	detectPackageManager: vi.fn(),
}))

describe('buildDevServerCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('should build pnpm dev command for pnpm projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/Users/test/workspace')

		expect(command).toBe('pnpm dev')
		expect(packageManager.detectPackageManager).toHaveBeenCalledWith(
			'/Users/test/workspace'
		)
	})

	it('should build npm run dev for npm projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('npm')

		const command = await buildDevServerCommand('/Users/test/workspace')

		expect(command).toBe('npm run dev')
	})

	it('should build yarn dev for yarn projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('yarn')

		const command = await buildDevServerCommand('/Users/test/workspace')

		expect(command).toBe('yarn dev')
	})

	it('should default to npm for unsupported package managers like bun', async () => {
		// Bun is not currently in the supported PackageManager type
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('bun' as 'pnpm')

		const command = await buildDevServerCommand('/Users/test/workspace')

		expect(command).toBe('npm run dev')
	})

	it('should default to npm when package manager is unknown', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('unknown' as 'pnpm')

		const command = await buildDevServerCommand('/Users/test/workspace')

		expect(command).toBe('npm run dev')
	})
})

describe('getDevServerLaunchCommand', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('should build complete terminal command with PORT export for web projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', 3042, ['web'])

		expect(command).toContain('PORT=3042')
		expect(command).toContain('pnpm dev')
		expect(command).toContain('&&')
	})

	it('should handle web projects without port', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', undefined, ['web'])

		expect(command).toContain('Starting dev server...')
		expect(command).toContain('pnpm dev')
		expect(command).not.toContain('PORT=')
	})

	it('should sequence commands with && properly for web projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('yarn')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', 3042, ['web'])

		// Should have three parts joined by &&
		const parts = command.split(' && ')
		expect(parts).toHaveLength(2)
		expect(parts[0]).toContain('echo')
		expect(parts[1]).toBe('yarn dev')
	})

	it('should use correct package manager command', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('yarn')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', 3042, ['web'])

		expect(command).toContain('yarn dev')
	})

	it('should omit dev server message for non-web projects', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', 3042, ['cli'])

		expect(command).toContain('pnpm dev')
		expect(command).not.toContain('Starting dev server')

		// Should only have one part for non-web projects
		const parts = command.split(' && ')
		expect(parts).toHaveLength(1)
		expect(parts[0]).toBe('pnpm dev')
	})

	it('should omit dev server message when no capabilities provided', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('npm')

		const command = await getDevServerLaunchCommand('/Users/test/workspace', 3000)

		expect(command).toContain('npm run dev')
		expect(command).not.toContain('Starting dev server')

		// Should only have one part when no capabilities
		const parts = command.split(' && ')
		expect(parts).toHaveLength(1)
		expect(parts[0]).toBe('npm run dev')
	})
})

describe('buildDevServerUrl', () => {
	it('should return http URL by default', () => {
		expect(buildDevServerUrl(3087)).toBe('http://localhost:3087')
	})

	it('should return http URL when protocol is http', () => {
		expect(buildDevServerUrl(3087, 'http')).toBe('http://localhost:3087')
	})

	it('should return https URL when protocol is https', () => {
		expect(buildDevServerUrl(3087, 'https')).toBe('https://localhost:3087')
	})
})
