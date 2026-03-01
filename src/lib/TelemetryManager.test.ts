import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TelemetryManager } from './TelemetryManager.js'
import fs from 'fs-extra'
import nodeFs from 'node:fs'
import os from 'os'
vi.mock('fs-extra')
vi.mock('node:fs')
vi.mock('os')

// uuid v10+ has overloads that confuse vi.mocked(); use vi.hoisted for a properly typed mock
const { mockUuidv4 } = vi.hoisted(() => ({
	mockUuidv4: vi.fn<() => string>(),
}))
vi.mock('uuid', () => ({ v4: mockUuidv4 }))

const CONFIG_PATH = '/tmp/test-config/telemetry.json'
const ID_PATH = '/tmp/test-config/telemetry-id'

/** Helper: create an ENOENT error */
function enoentError(): NodeJS.ErrnoException {
	const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
	err.code = 'ENOENT'
	return err
}

/**
 * Helper: mock the ID file read.
 * If `id` is provided, readFileSync returns it for the ID_PATH.
 * If `id` is null, readFileSync throws ENOENT for the ID_PATH.
 */
function mockIdFile(id: string | null): void {
	vi.mocked(nodeFs.readFileSync).mockImplementation((filePath) => {
		if (filePath === ID_PATH) {
			if (id === null) throw enoentError()
			return id
		}
		return ''
	})
}

/** Helper: assert that an atomic write occurred with the expected config content */
function expectAtomicWrite(configPath: string, expected: Record<string, unknown>): void {
	const tmpPath = `${configPath}.${process.pid}.tmp`
	expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
	expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, configPath)

	// Verify the written JSON content matches expectations
	const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
		(call) => call[0] === tmpPath,
	)
	expect(writtenData).toBeDefined()
	const parsed = JSON.parse(writtenData![1] as string)
	expect(parsed).toEqual(expect.objectContaining(expected))
	// Verify distinct_id is NEVER written to telemetry.json
	expect(parsed).not.toHaveProperty('distinct_id')
}

describe('TelemetryManager', () => {
	beforeEach(() => {
		vi.mocked(os.homedir).mockReturnValue('/home/user')
	})

	describe('distinct ID file', () => {
		it('reads existing ID from telemetry-id file', () => {
			mockIdFile('existing-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('existing-id')
			expect(mockUuidv4).not.toHaveBeenCalled()
			// Should not write to ID file when it already exists
			expect(nodeFs.writeFileSync).not.toHaveBeenCalledWith(ID_PATH, expect.anything(), expect.anything())
		})

		it('generates and writes new ID when telemetry-id does not exist', () => {
			mockIdFile(null)
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('new-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('new-uuid')
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(ID_PATH, 'new-uuid', 'utf8')
		})

		it('handles empty telemetry-id file as missing (generates new)', () => {
			mockIdFile('')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('fallback-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('fallback-uuid')
		})

		it('handles whitespace-only telemetry-id as missing', () => {
			mockIdFile('   \n  ')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('fallback-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('fallback-uuid')
		})

		it('trims whitespace from read ID', () => {
			mockIdFile('  some-uuid  \n')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('some-uuid')
		})

		it('handles permission errors reading ID file gracefully', () => {
			vi.mocked(nodeFs.readFileSync).mockImplementation((filePath) => {
				if (filePath === ID_PATH) {
					const err = new Error('EACCES') as NodeJS.ErrnoException
					err.code = 'EACCES'
					throw err
				}
				return ''
			})
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('generated-uuid')
		})
	})

	describe('getDistinctId', () => {
		it('getDistinctId is a simple getter (no additional write)', () => {
			mockIdFile(null)
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('test-uuid-5678')

			const manager = new TelemetryManager('/tmp/test-config')
			vi.mocked(nodeFs.writeFileSync).mockClear()
			vi.mocked(nodeFs.renameSync).mockClear()

			manager.getDistinctId()

			expect(nodeFs.writeFileSync).not.toHaveBeenCalled()
			expect(nodeFs.renameSync).not.toHaveBeenCalled()
		})
	})

	describe('isEnabled', () => {
		it('returns true by default (no config file)', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})

		it('returns false when config has enabled: false', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: false })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
		})

		it('returns true when config has enabled: true', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})

		it('returns false on read errors (corrupted file disables telemetry)', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new Error('Permission denied')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
		})
	})

	describe('enable / disable', () => {
		it('disable() sets enabled: false and writes config atomically', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			expect(manager.isEnabled()).toBe(false)
			expectAtomicWrite(CONFIG_PATH, { enabled: false })
		})

		it('enable() sets enabled: true and writes config atomically', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: false })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.enable()

			expect(manager.isEnabled()).toBe(true)
			expectAtomicWrite(CONFIG_PATH, { enabled: true })
		})

		it('preserves other config fields when toggling', () => {
			mockIdFile('preserved-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({
				enabled: true,
				disclosed_at: '2026-01-01T00:00:00.000Z',
				last_version: '1.0.0',
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			expectAtomicWrite(CONFIG_PATH, {
				enabled: false,
				disclosed_at: '2026-01-01T00:00:00.000Z',
				last_version: '1.0.0',
			})
		})

		it('handles write errors silently', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })
			vi.mocked(nodeFs.writeFileSync).mockImplementation((filePath) => {
				if (filePath === ID_PATH) return
				throw new Error('Disk full')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(() => manager.disable()).not.toThrow()
		})
	})

	describe('getStatus', () => {
		it('returns { enabled, distinctId } from current config', () => {
			mockIdFile('status-uuid')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			const status = manager.getStatus()

			expect(status).toEqual({ enabled: true, distinctId: 'status-uuid' })
		})
	})

	describe('write-once ID behavior', () => {
		it('generates and persists distinct_id at construction time when ID file missing', () => {
			mockIdFile(null)
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('generated-uuid')
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(ID_PATH, 'generated-uuid', 'utf8')
		})

		it('does not regenerate distinct_id when ID file already has one', () => {
			mockIdFile('existing-uuid')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			new TelemetryManager('/tmp/test-config')

			expect(mockUuidv4).not.toHaveBeenCalled()
		})

		it('writeConfig never includes distinct_id in telemetry.json', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.markDisclosed()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
				(call) => call[0] === tmpPath,
			)
			expect(writtenData).toBeDefined()
			const parsed = JSON.parse(writtenData![1] as string)
			expect(parsed).not.toHaveProperty('distinct_id')
		})
	})

	describe('hasBeenDisclosed / markDisclosed', () => {
		it('hasBeenDisclosed() returns false when disclosed_at is not set', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.hasBeenDisclosed()).toBe(false)
		})

		it('hasBeenDisclosed() returns true when disclosed_at is set', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({
				enabled: true,
				disclosed_at: '2026-01-01T00:00:00.000Z',
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.hasBeenDisclosed()).toBe(true)
		})

		it('markDisclosed() sets disclosed_at to ISO timestamp', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.markDisclosed()

			expect(manager.hasBeenDisclosed()).toBe(true)

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
				(call) => call[0] === tmpPath,
			)
			expect(writtenData).toBeDefined()
			const parsed = JSON.parse(writtenData![1] as string)
			expect(parsed.disclosed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		})
	})

	describe('getLastVersion / setLastVersion', () => {
		it('getLastVersion() returns null when not set', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getLastVersion()).toBeNull()
		})

		it('getLastVersion() returns stored version string', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({
				enabled: true,
				last_version: '0.9.2',
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getLastVersion()).toBe('0.9.2')
		})

		it('setLastVersion() persists version to config', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.setLastVersion('1.2.3')

			expect(manager.getLastVersion()).toBe('1.2.3')
			expectAtomicWrite(CONFIG_PATH, { last_version: '1.2.3' })
		})

		it('setLastVersion() skips write when version is unchanged', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({
				enabled: true,
				last_version: '0.9.2',
			})

			const manager = new TelemetryManager('/tmp/test-config')
			vi.mocked(nodeFs.writeFileSync).mockClear()

			manager.setLastVersion('0.9.2')

			expect(nodeFs.writeFileSync).not.toHaveBeenCalled()
		})
	})

	describe('error resilience', () => {
		it('constructor handles missing config directory gracefully', () => {
			mockIdFile(null)
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory')
			})
			mockUuidv4.mockReturnValue('some-uuid')

			expect(() => new TelemetryManager('/nonexistent/dir')).not.toThrow()
		})

		it('all write methods handle permission errors silently', () => {
			mockIdFile(null)
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			vi.mocked(fs.ensureDirSync).mockImplementation(() => {
				throw new Error('EACCES: permission denied')
			})
			mockUuidv4.mockReturnValue('some-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(() => manager.getDistinctId()).not.toThrow()
			expect(() => manager.enable()).not.toThrow()
			expect(() => manager.disable()).not.toThrow()
			expect(() => manager.markDisclosed()).not.toThrow()
			expect(() => manager.setLastVersion('1.0.0')).not.toThrow()
		})

		it('corrupt JSON file disables telemetry to respect user privacy', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new SyntaxError('Unexpected token')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
			expect(manager.hasBeenDisclosed()).toBe(false)
			expect(manager.getLastVersion()).toBeNull()
		})

		it('corrupt config does not affect distinct_id from ID file', () => {
			mockIdFile('stable-id')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new SyntaxError('Unexpected token')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('stable-id')
			expect(manager.isEnabled()).toBe(false)
		})

		it('missing file (ENOENT) defaults to enabled', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})
	})

	describe('config validation', () => {
		it('handles config with non-boolean enabled', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({
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
			vi.mocked(nodeFs.readFileSync).mockImplementation((filePath) => {
				if (filePath === '/home/testuser/.config/iloom-ai/telemetry-id') {
					return 'some-id'
				}
				return ''
			})
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager()
			manager.disable()

			const expectedConfig = '/home/testuser/.config/iloom-ai/telemetry.json'
			const tmpPath = `${expectedConfig}.${process.pid}.tmp`
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
			expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, expectedConfig)
		})
	})

	describe('atomic writes', () => {
		it('writes to a temp file in the same directory and renames to the config path', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			expect(fs.ensureDirSync).toHaveBeenCalledWith('/tmp/test-config')
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
			expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, CONFIG_PATH)
		})

		it('writes valid JSON with 2-space indentation and no distinct_id', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
				(call) => call[0] === tmpPath,
			)
			expect(writtenData).toBeDefined()
			const content = writtenData![1] as string
			// Verify it's valid JSON
			const parsed = JSON.parse(content)
			expect(parsed).not.toHaveProperty('distinct_id')
			expect(parsed).toHaveProperty('enabled', false)
			// Verify 2-space indentation
			expect(content).toBe(JSON.stringify(parsed, null, 2))
		})

		it('cleans up temp file if rename fails', () => {
			mockIdFile('some-id')
			vi.mocked(fs.readJsonSync).mockReturnValue({ enabled: true })
			vi.mocked(nodeFs.renameSync).mockImplementation(() => {
				throw new Error('rename failed')
			})

			const manager = new TelemetryManager('/tmp/test-config')
			expect(() => manager.disable()).not.toThrow()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			expect(nodeFs.unlinkSync).toHaveBeenCalledWith(tmpPath)
		})
	})
})
