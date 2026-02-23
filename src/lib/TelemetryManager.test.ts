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

/** Helper: assert that an atomic write occurred with the expected config content */
function expectAtomicWrite(configPath: string, expected: Record<string, unknown>): void {
	const tmpPath = `${configPath}.${process.pid}.tmp`
	expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
	expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, configPath)

	// Verify the written JSON content matches expectations
	const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
		(call) => call[0] === tmpPath
	)
	expect(writtenData).toBeDefined()
	const parsed = JSON.parse(writtenData![1] as string)
	expect(parsed).toEqual(expect.objectContaining(expected))
}

/** Helper: create an ENOENT error */
function enoentError(): NodeJS.ErrnoException {
	const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
	err.code = 'ENOENT'
	return err
}

const CONFIG_PATH = '/tmp/test-config/telemetry.json'

describe('TelemetryManager', () => {
	beforeEach(() => {
		vi.mocked(os.homedir).mockReturnValue('/home/user')
	})

	describe('getDistinctId', () => {
		it('returns generated UUID when no config file exists', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('test-uuid-1234')

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('test-uuid-1234')
		})

		it('getDistinctId is a simple getter (no additional write)', () => {
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

		it('returns existing UUID from config on subsequent calls', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'existing-uuid',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('existing-uuid')
			expect(mockUuidv4).not.toHaveBeenCalled()
		})

		it('generates new UUID if config has empty distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: '',
				enabled: true,
			})
			mockUuidv4.mockReturnValue('new-uuid')

			const manager = new TelemetryManager('/tmp/test-config')
			const id = manager.getDistinctId()

			expect(id).toBe('new-uuid')
		})
	})

	describe('isEnabled', () => {
		it('returns true by default (no config file)', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
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

		it('returns false on read errors (corrupted file disables telemetry)', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new Error('Permission denied')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
		})
	})

	describe('enable / disable', () => {
		it('disable() sets enabled: false and writes config atomically', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			expect(manager.isEnabled()).toBe(false)
			expectAtomicWrite(CONFIG_PATH, { enabled: false })
		})

		it('enable() sets enabled: true and writes config atomically', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: false,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.enable()

			expect(manager.isEnabled()).toBe(true)
			expectAtomicWrite(CONFIG_PATH, { enabled: true })
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

			expectAtomicWrite(CONFIG_PATH, {
				distinct_id: 'preserved-id',
				enabled: false,
				disclosed_at: '2026-01-01T00:00:00.000Z',
				last_version: '1.0.0',
			})
		})

		it('handles write errors silently', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})
			vi.mocked(nodeFs.writeFileSync).mockImplementation(() => {
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

	describe('eager ID generation', () => {
		it('generates and persists distinct_id at construction time when missing', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('generated-uuid')
			expectAtomicWrite(CONFIG_PATH, { distinct_id: 'generated-uuid' })
		})

		it('does not regenerate distinct_id when file already has one', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'existing-uuid',
				enabled: true,
			})

			new TelemetryManager('/tmp/test-config')

			expect(mockUuidv4).not.toHaveBeenCalled()
		})

		it('all writes include the generated distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')
			manager.markDisclosed()

			expectAtomicWrite(CONFIG_PATH, { distinct_id: 'generated-uuid' })
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

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
				(call) => call[0] === tmpPath
			)
			expect(writtenData).toBeDefined()
			const parsed = JSON.parse(writtenData![1] as string)
			expect(parsed.disclosed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
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
			expectAtomicWrite(CONFIG_PATH, { last_version: '1.2.3' })
		})

		it('setLastVersion() skips write when version is unchanged', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
				last_version: '0.9.2',
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.setLastVersion('0.9.2')

			expect(nodeFs.writeFileSync).not.toHaveBeenCalled()
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
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new SyntaxError('Unexpected token')
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(false)
			expect(manager.hasBeenDisclosed()).toBe(false)
			expect(manager.getLastVersion()).toBeNull()
		})

		it('missing file (ENOENT) defaults to enabled', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.isEnabled()).toBe(true)
		})
	})

	describe('config validation', () => {
		it('handles config with non-string distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 12345,
				enabled: true,
			})
			mockUuidv4.mockReturnValue('fallback-uuid')

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

			const expectedConfig = '/home/testuser/.config/iloom-ai/telemetry.json'
			const tmpPath = `${expectedConfig}.${process.pid}.tmp`
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
			expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, expectedConfig)
		})
	})

	describe('atomic writes', () => {
		it('writes to a temp file in the same directory and renames to the config path', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			expect(fs.ensureDirSync).toHaveBeenCalledWith('/tmp/test-config')
			expect(nodeFs.writeFileSync).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8')
			expect(nodeFs.renameSync).toHaveBeenCalledWith(tmpPath, CONFIG_PATH)
		})

		it('writes valid JSON with 2-space indentation', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})

			const manager = new TelemetryManager('/tmp/test-config')
			manager.disable()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			const writtenData = vi.mocked(nodeFs.writeFileSync).mock.calls.find(
				(call) => call[0] === tmpPath
			)
			expect(writtenData).toBeDefined()
			const content = writtenData![1] as string
			// Verify it's valid JSON
			const parsed = JSON.parse(content)
			expect(parsed).toHaveProperty('distinct_id', 'some-id')
			// Verify 2-space indentation
			expect(content).toBe(JSON.stringify(parsed, null, 2))
		})

		it('cleans up temp file if rename fails', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'some-id',
				enabled: true,
			})
			vi.mocked(nodeFs.renameSync).mockImplementation(() => {
				throw new Error('rename failed')
			})

			const manager = new TelemetryManager('/tmp/test-config')
			expect(() => manager.disable()).not.toThrow()

			const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`
			expect(nodeFs.unlinkSync).toHaveBeenCalledWith(tmpPath)
		})
	})

	describe('re-read guard on UUID generation', () => {
		it('prefers existing distinct_id from re-read over generated UUID', () => {
			let readCount = 0
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				readCount++
				if (readCount === 1) {
					// First read: file doesn't exist
					throw enoentError()
				}
				// Second read (re-read guard): another process wrote a config
				return {
					distinct_id: 'existing-from-other-process',
					enabled: true,
					disclosed_at: '2026-01-15T00:00:00.000Z',
				}
			})
			mockUuidv4.mockReturnValue('my-generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			// Should use the existing ID from the re-read, not the generated one
			expect(manager.getDistinctId()).toBe('existing-from-other-process')
			// Should also pick up other fields from the re-read
			expect(manager.isEnabled()).toBe(true)
			expect(manager.hasBeenDisclosed()).toBe(true)
			// Should NOT have written (another process already did)
			expect(nodeFs.writeFileSync).not.toHaveBeenCalled()
		})

		it('uses generated UUID when re-read also finds no distinct_id', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('my-generated-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			expect(manager.getDistinctId()).toBe('my-generated-uuid')
			// Should have written since re-read also found nothing
			expectAtomicWrite(CONFIG_PATH, { distinct_id: 'my-generated-uuid' })
		})

		it('reads config exactly twice when distinct_id is missing (initial + re-read)', () => {
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw enoentError()
			})
			mockUuidv4.mockReturnValue('some-uuid')

			new TelemetryManager('/tmp/test-config')

			expect(fs.readJsonSync).toHaveBeenCalledTimes(2)
		})

		it('reads config exactly once when distinct_id already exists', () => {
			vi.mocked(fs.readJsonSync).mockReturnValue({
				distinct_id: 'existing-id',
				enabled: true,
			})

			new TelemetryManager('/tmp/test-config')

			expect(fs.readJsonSync).toHaveBeenCalledTimes(1)
		})
	})

	describe('corruption leads to disabled telemetry', () => {
		it('corrupt file on initial read disables telemetry and generates new distinct_id', () => {
			// Simulates: concurrent process truncated the file, this process reads garbage
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				throw new SyntaxError('Unexpected end of JSON input')
			})
			mockUuidv4.mockReturnValue('recovery-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			// Telemetry should be disabled (corruption path returns enabled: false)
			// Both initial read AND re-read hit corruption, so telemetry stays disabled
			expect(manager.isEnabled()).toBe(false)
			// A distinct_id is still generated (for the case where corruption is transient)
			expect(manager.getDistinctId()).toBe('recovery-uuid')
		})

		it('corrupt initial read but valid re-read recovers the existing distinct_id', () => {
			let readCount = 0
			vi.mocked(fs.readJsonSync).mockImplementation(() => {
				readCount++
				if (readCount === 1) {
					// First read: corrupt file (mid-write by another process)
					throw new SyntaxError('Unexpected token')
				}
				// Re-read: other process finished writing, file is now valid
				return {
					distinct_id: 'recovered-id',
					enabled: true,
				}
			})
			mockUuidv4.mockReturnValue('unused-uuid')

			const manager = new TelemetryManager('/tmp/test-config')

			// Should recover the ID from the re-read
			expect(manager.getDistinctId()).toBe('recovered-id')
			// Should adopt the enabled state from the valid re-read
			expect(manager.isEnabled()).toBe(true)
		})
	})
})
