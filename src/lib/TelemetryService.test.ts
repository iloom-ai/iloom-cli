import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostHog } from 'posthog-node'
import { TelemetryService } from './TelemetryService.js'
import { TelemetryManager } from './TelemetryManager.js'

vi.mock('posthog-node', () => ({
	PostHog: vi.fn(),
}))

vi.mock('./TelemetryManager.js', () => ({
	TelemetryManager: vi.fn(),
}))

vi.mock('../utils/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockCapture = vi.fn()
const mockShutdown = vi.fn().mockResolvedValue(undefined)

function createMockManager(overrides: Partial<{ isEnabled: boolean; distinctId: string }> = {}) {
	return {
		isEnabled: vi.fn().mockReturnValue(overrides.isEnabled ?? true),
		getDistinctId: vi.fn().mockReturnValue(overrides.distinctId ?? 'test-uuid-1234'),
	} as unknown as TelemetryManager
}

describe('TelemetryService', () => {
	beforeEach(() => {
		TelemetryService.resetInstance()
		mockCapture.mockReset()
		mockShutdown.mockReset().mockResolvedValue(undefined)
		vi.mocked(PostHog).mockImplementation(() => ({
			capture: mockCapture,
			shutdown: mockShutdown,
		}) as unknown as PostHog)
	})

	describe('getInstance', () => {
		it('returns a singleton instance', () => {
			vi.mocked(TelemetryManager).mockImplementation(() => createMockManager())
			const a = TelemetryService.getInstance()
			const b = TelemetryService.getInstance()
			expect(a).toBe(b)
		})
	})

	describe('getManager', () => {
		it('exposes the internal TelemetryManager instance', () => {
			const manager = createMockManager()
			const service = new TelemetryService(manager)
			expect(service.getManager()).toBe(manager)
		})
	})

	describe('track', () => {
		it('sends event via posthog.capture() when enabled', () => {
			const service = new TelemetryService(createMockManager())
			service.track('test.event')
			expect(mockCapture).toHaveBeenCalledWith({
				distinctId: 'test-uuid-1234',
				event: 'test.event',
				properties: { source: 'cli' },
			})
		})

		it('adds source: "cli" to all event properties', () => {
			const service = new TelemetryService(createMockManager())
			service.track('test.event', { foo: 'bar' })
			expect(mockCapture).toHaveBeenCalledWith({
				distinctId: 'test-uuid-1234',
				event: 'test.event',
				properties: { source: 'cli', foo: 'bar' },
			})
		})

		it('merges source with provided properties', () => {
			const service = new TelemetryService(createMockManager())
			service.track('test.event', { version: '1.0.0', os: 'darwin' })
			expect(mockCapture).toHaveBeenCalledWith({
				distinctId: 'test-uuid-1234',
				event: 'test.event',
				properties: { source: 'cli', version: '1.0.0', os: 'darwin' },
			})
		})

		it('is a silent no-op when telemetry is disabled', () => {
			const service = new TelemetryService(createMockManager({ isEnabled: false }))
			service.track('test.event')
			expect(mockCapture).not.toHaveBeenCalled()
		})

		it('catches PostHog capture errors silently', () => {
			mockCapture.mockImplementation(() => {
				throw new Error('PostHog capture failed')
			})
			const service = new TelemetryService(createMockManager())
			expect(() => service.track('test.event')).not.toThrow()
		})

		it('uses distinctId from TelemetryManager', () => {
			const service = new TelemetryService(createMockManager({ distinctId: 'custom-uuid-5678' }))
			service.track('test.event')
			expect(mockCapture).toHaveBeenCalledWith(
				expect.objectContaining({ distinctId: 'custom-uuid-5678' }),
			)
		})
	})

	describe('shutdown', () => {
		it('calls posthog.shutdown() to flush events', async () => {
			const service = new TelemetryService(createMockManager())
			await service.shutdown()
			expect(mockShutdown).toHaveBeenCalled()
		})

		it('resolves within timeout even if posthog.shutdown() hangs', async () => {
			mockShutdown.mockImplementation(() => new Promise(() => {}))
			const service = new TelemetryService(createMockManager())
			const start = Date.now()
			await service.shutdown()
			const elapsed = Date.now() - start
			expect(elapsed).toBeLessThan(3000)
		})

		it('handles missing PostHog client gracefully (disabled telemetry)', async () => {
			const service = new TelemetryService(createMockManager({ isEnabled: false }))
			await expect(service.shutdown()).resolves.toBeUndefined()
		})

		it('catches shutdown errors silently', async () => {
			mockShutdown.mockRejectedValue(new Error('shutdown failed'))
			const service = new TelemetryService(createMockManager())
			await expect(service.shutdown()).resolves.toBeUndefined()
		})
	})

	describe('disabled telemetry', () => {
		it('does not initialize PostHog client when disabled', () => {
			vi.mocked(PostHog).mockClear()
			new TelemetryService(createMockManager({ isEnabled: false }))
			expect(PostHog).not.toHaveBeenCalled()
		})

		it('track() does nothing when disabled', () => {
			const service = new TelemetryService(createMockManager({ isEnabled: false }))
			service.track('test.event', { data: 'value' })
			expect(mockCapture).not.toHaveBeenCalled()
		})

		it('shutdown() resolves immediately when disabled', async () => {
			const service = new TelemetryService(createMockManager({ isEnabled: false }))
			await expect(service.shutdown()).resolves.toBeUndefined()
			expect(mockShutdown).not.toHaveBeenCalled()
		})
	})
})
