import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildDevServerCommand, getDevServerLaunchCommand, detectAngularProject } from './dev-server.js'
import * as packageManager from './package-manager.js'
import fs from 'fs-extra'

// Mock package-manager module
vi.mock('./package-manager.js', () => ({
	detectPackageManager: vi.fn(),
}))

// Mock fs-extra
vi.mock('fs-extra', () => ({
	default: {
		pathExists: vi.fn(),
	},
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

describe('buildDevServerCommand with portFlag', () => {
	beforeEach(() => {
		vi.mocked(fs.pathExists).mockResolvedValue(false)
	})

	it('should append portFlag when both portFlag and port are provided', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/path', { port: 3042, portFlag: '--port' })

		expect(command).toBe('pnpm dev -- --port=3042')
	})

	it('should not append portFlag when port is undefined', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/path', { portFlag: '--port' })

		expect(command).toBe('pnpm dev')
	})

	it('should not append portFlag when portFlag is undefined', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/path', { port: 3042 })

		expect(command).toBe('pnpm dev')
	})

	it('should not append portFlag when portFlag is empty string', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/path', { port: 3042, portFlag: '' })

		expect(command).toBe('pnpm dev')
	})

	it('should handle different portFlag formats (-p)', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		const command = await buildDevServerCommand('/path', { port: 4200, portFlag: '-p' })

		expect(command).toBe('pnpm dev -- -p=4200')
	})

	it('should handle different portFlag formats (--serve-port)', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('npm')

		const command = await buildDevServerCommand('/path', { port: 8080, portFlag: '--serve-port' })

		expect(command).toBe('npm run dev -- --serve-port=8080')
	})

	it('should auto-detect Angular and use --port when portFlag not provided', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')
		vi.mocked(fs.pathExists).mockResolvedValue(true)

		const command = await buildDevServerCommand('/angular-project', { port: 4200 })

		expect(command).toBe('pnpm dev -- --port=4200')
		expect(fs.pathExists).toHaveBeenCalledWith('/angular-project/angular.json')
	})

	it('should not auto-detect Angular when portFlag is explicitly set', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')
		vi.mocked(fs.pathExists).mockResolvedValue(true)

		const command = await buildDevServerCommand('/angular-project', { port: 4200, portFlag: '-p' })

		expect(command).toBe('pnpm dev -- -p=4200')
	})

	it('should not call Angular detection when portFlag is explicitly set', async () => {
		vi.mocked(packageManager.detectPackageManager).mockResolvedValue('pnpm')

		await buildDevServerCommand('/angular-project', { port: 4200, portFlag: '--port' })

		expect(fs.pathExists).not.toHaveBeenCalled()
	})
})

describe('detectAngularProject', () => {
	it('should return true when angular.json exists', async () => {
		vi.mocked(fs.pathExists).mockResolvedValue(true)

		const result = await detectAngularProject('/path/to/angular')

		expect(result).toBe(true)
		expect(fs.pathExists).toHaveBeenCalledWith('/path/to/angular/angular.json')
	})

	it('should return false when angular.json does not exist', async () => {
		vi.mocked(fs.pathExists).mockResolvedValue(false)

		const result = await detectAngularProject('/path/to/react')

		expect(result).toBe(false)
		expect(fs.pathExists).toHaveBeenCalledWith('/path/to/react/angular.json')
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
