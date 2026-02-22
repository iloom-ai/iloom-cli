import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TelemetryManager } from './TelemetryManager.js'
import fs from 'fs-extra'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'

vi.mock('fs-extra')
vi.mock('os')
vi.mock('uuid', () => ({ v4: vi.fn() }))

describe('TelemetryManager', () => {
	beforeEach(() => {
		vi.mocked(os.homedir).mockReturnValue('/home/user')
	})

	describe('getDistinctId', () => {
		it('returns generated UUID when no config file exists', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
				err.code = 'ENOENT'
				throw err
			})
			vi.mocked(uuidv4).mockReturnValue('test-uuid-1234')

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('test-uuid-1234')
		})

		it('persists UUID to config file on first call', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
				err.code = 'ENOENT'
				throw err
			})
			vi.mocked(uuidv4).mockReturnValue('test-uuid-5678')

			const manager = new TelemetryManager('/tmp/test-config')
			manager.getDistinctId()

			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({ distinct_id: 'test-uuid-5678' }),
				{ spaces: 2 }
			)
		})

		it('returns existing UUID from config on subsequent calls', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'existing-uuid',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('existing-uuid')
			expect(uuidv4).not.toHaveBeenCalled()
		})

		it('generates new UUID if config has empty distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: '',
				enabled: true,
			})
			vi.mocked(uuidv4).mockReturnValue('new-uuid')

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('new-uuid')
		})
	})

	describe('isEnabled', () => {
		it('returns true by default (no config file)', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
				err.code = 'ENOENT'
				throw err
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})

		it('returns false when config has enabled: false', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: false,
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
		})

		it('returns true when config has enabled: true', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})

		it('returns true on read errors (default to enabled)', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new Error('Permission denied')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})
	})

	describe('enable / disable', () => {
		it('disable() sets enabled: false and writes config', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			expect(manager.isEnabled()).toBe(false)
			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({ enabled: false }),
				{ spaces: 2 }
			)
		})

		it('enable() sets enabled: true and writes config', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: false,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.enable()

			expect(manager.isEnabled()).toBe(true)
			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({ enabled: true }),
				{ spaces: 2 }
			)
		})

		it('preserves other config fields when toggling', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'preserved-id',
				enabled: true,
				disclosed_at: '2026-01-01T00:00:00.000Z',
				last_version: '1.0.0',
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({
					distinct_id: 'preserved-id',
					enabled: false,
					disclosed_at: '2026-01-01T00:00:00.000Z',
					last_version: '1.0.0',
				}),
				{ spaces: 2 }
			)
		})

		it('handles write errors silently', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})
			vi.mocked(fs.writeJsonSync).mockImplementation(() => {
				throw new Error('Disk full')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(() => manager.disable()).not.toThrow()
		})
	})

	describe('getStatus', () => {
		it('returns { enabled, distinctId } from current config', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'status-uuid',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			const status = manager.getStatus()

			expect(status).toEqual({ enabled: true, distinctId: 'status-uuid' })
		})
	})

	describe('hasBeenDisclosed / markDisclosed', () => {
		it('hasBeenDisclosed() returns false when disclosed_at is not set', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.hasBeenDisclosed()).toBe(false)
		})

		it('hasBeenDisclosed() returns true when disclosed_at is set', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
				disclosed_at: '2026-01-01T00:00:00.000Z',
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.hasBeenDisclosed()).toBe(true)
		})

		it('markDisclosed() sets disclosed_at to ISO timestamp', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.markDisclosed()

			expect(manager.hasBeenDisclosed()).toBe(true)
			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({
					disclosed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				}),
				{ spaces: 2 }
			)
		})
	})

	describe('getLastVersion / setLastVersion', () => {
		it('getLastVersion() returns null when not set', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getLastVersion()).toBeNull()
		})

		it('getLastVersion() returns stored version string', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
				last_version: '0.9.2',
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getLastVersion()).toBe('0.9.2')
		})

		it('setLastVersion() persists version to config', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.setLastVersion('1.2.3')

			expect(manager.getLastVersion()).toBe('1.2.3')
			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/tmp/test-config/telemetry.json',
				expect.objectContaining({ last_version: '1.2.3' }),
				{ spaces: 2 }
			)
		})
	})

	describe('error resilience', () => {
		it('constructor handles missing config directory gracefully', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory')
			})

			expect(() => new TelemetryManager('/nonexistent/dir')).not.toThrow()
		})

		it('all write methods handle permission errors silently', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
				err.code = 'ENOENT'
				throw err
			})
			vi.mocked(fs.ensureDirSync).mockImplementation(() => {
				throw new Error('EACCES: permission denied')
			})
			vi.mocked(uuidv4).mockReturnValue('some-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(() => manager.getDistinctId()).not.toThrow()
			expect(() => manager.enable()).not.toThrow()
			expect(() => manager.disable()).not.toThrow()
			expect(() => manager.markDisclosed()).not.toThrow()
			expect(() => manager.setLastVersion('1.0.0')).not.toThrow()
		})

		it('corrupt JSON file falls back to defaults', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new SyntaxError('Unexpected token')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
			expect(manager.hasBeenDisclosed()).toBe(false)
			expect(manager.getLastVersion()).toBeNull()
		})
	})

	describe('config validation', () => {
		it('handles config with non-string distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 12345,
				enabled: true,
			})
			vi.mocked(uuidv4).mockReturnValue('fallback-uuid')

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('fallback-uuid')
		})

		it('handles config with non-boolean enabled', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: 'yes',
			})

			const manager = new TelemetryManager('/tmp/test-config')

			// Non-boolean should default to true
			expect(manager.isEnabled()).toBe(true)
		})
	})

	describe('default config directory', () => {
		it('uses ~/.config/iloom-ai when no configDir provided', () => {
			vi.mocked(os.homedir).mockReturnValue('/home/testuser')
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager()
			manager.disable()

			expect(fs.writeJsonSync).toHaveBeenCalledWith(
				'/home/testuser/.config/iloom-ai/telemetry.json',
				expect.any(Object),
				{ spaces: 2 }
			)
		})
	})
})
