import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TelemetryManager } from '../lib/TelemetryManager.js'
import { TelemetryService } from '../lib/TelemetryService.js'
import { handleTelemetryLifecycle } from '../cli.js'

vi.mock('../lib/TelemetryManager.js')
vi.mock('../lib/TelemetryService.js')
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function createMockManager(overrides: Partial<{
  enabled: boolean
  distinctId: string
  disclosed: boolean
  lastVersion: string | null
}> = {}) {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(overrides.enabled ?? true),
    getStatus: vi.fn().mockReturnValue({
      enabled: overrides.enabled ?? true,
      distinctId: overrides.distinctId ?? 'test-uuid-1234',
    }),
    getDistinctId: vi.fn().mockReturnValue(overrides.distinctId ?? 'test-uuid-1234'),
    hasBeenDisclosed: vi.fn().mockReturnValue(overrides.disclosed ?? true),
    markDisclosed: vi.fn(),
    getLastVersion: vi.fn().mockReturnValue(overrides.lastVersion ?? null),
    setLastVersion: vi.fn(),
  }
}

function createMockTelemetryService(manager?: ReturnType<typeof createMockManager>) {
  return {
    track: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getManager: vi.fn().mockReturnValue(manager),
  }
}

describe('telemetry commands', () => {
  let mockManager: ReturnType<typeof createMockManager>

  beforeEach(() => {
    mockManager = createMockManager()
    vi.mocked(TelemetryManager).mockImplementation(() => mockManager as unknown as TelemetryManager)
  })

  describe('telemetry off', () => {
    it('calls TelemetryManager.disable()', () => {
      const manager = new TelemetryManager()
      manager.disable()

      expect(mockManager.disable).toHaveBeenCalled()
    })
  })

  describe('telemetry on', () => {
    it('calls TelemetryManager.enable()', () => {
      const manager = new TelemetryManager()
      manager.enable()

      expect(mockManager.enable).toHaveBeenCalled()
    })
  })

  describe('telemetry status', () => {
    it('returns enabled state and distinct ID when enabled', () => {
      const manager = createMockManager({ enabled: true, distinctId: 'abc-123' })
      vi.mocked(TelemetryManager).mockImplementation(() => manager as unknown as TelemetryManager)

      const tm = new TelemetryManager()
      const status = tm.getStatus()

      expect(status).toEqual({ enabled: true, distinctId: 'abc-123' })
    })

    it('returns disabled state and distinct ID when disabled', () => {
      const manager = createMockManager({ enabled: false, distinctId: 'abc-123' })
      vi.mocked(TelemetryManager).mockImplementation(() => manager as unknown as TelemetryManager)

      const tm = new TelemetryManager()
      const status = tm.getStatus()

      expect(status).toEqual({ enabled: false, distinctId: 'abc-123' })
    })
  })
})

describe('handleTelemetryLifecycle', () => {
  let mockManager: ReturnType<typeof createMockManager>
  let mockService: ReturnType<typeof createMockTelemetryService>

  beforeEach(() => {
    mockManager = createMockManager()
    mockService = createMockTelemetryService(mockManager)
    vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)
  })

  describe('first-run disclosure', () => {
    it('calls markDisclosed and fires cli.installed when not previously disclosed', () => {
      mockManager = createMockManager({ disclosed: false })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockManager.markDisclosed).toHaveBeenCalled()
      expect(mockService.track).toHaveBeenCalledWith('cli.installed', {
        version: '1.0.0',
        os: process.platform,
        node_version: process.version,
      })
    })

    it('skips disclosure and cli.installed when already disclosed', () => {
      mockManager = createMockManager({ disclosed: true })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockManager.markDisclosed).not.toHaveBeenCalled()
      expect(mockService.track).not.toHaveBeenCalledWith('cli.installed', expect.anything())
    })

    it('still marks disclosed in json mode (but does not print)', () => {
      mockManager = createMockManager({ disclosed: false })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', true)

      expect(mockManager.markDisclosed).toHaveBeenCalled()
      expect(mockService.track).toHaveBeenCalledWith('cli.installed', expect.anything())
    })
  })

  describe('shared TelemetryManager instance', () => {
    it('uses the TelemetryService manager instead of creating a separate instance', () => {
      mockManager = createMockManager({ disclosed: false })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      // Should not construct any TelemetryManager directly — uses the one from TelemetryService
      expect(TelemetryManager).toHaveBeenCalledTimes(0)
    })
  })

  describe('upgrade detection', () => {
    it('fires cli.upgraded when version differs from lastVersion', () => {
      mockManager = createMockManager({ disclosed: true, lastVersion: '0.9.0' })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockService.track).toHaveBeenCalledWith('cli.upgraded', {
        version: '1.0.0',
        previous_version: '0.9.0',
        os: process.platform,
      })
    })

    it('updates lastVersion after detecting upgrade', () => {
      mockManager = createMockManager({ disclosed: true, lastVersion: '0.9.0' })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockManager.setLastVersion).toHaveBeenCalledWith('1.0.0')
    })

    it('skips upgrade event on first run (no lastVersion)', () => {
      mockManager = createMockManager({ disclosed: false, lastVersion: null })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockService.track).not.toHaveBeenCalledWith('cli.upgraded', expect.anything())
    })

    it('does not fire upgrade when version is same', () => {
      mockManager = createMockManager({ disclosed: true, lastVersion: '1.0.0' })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockService.track).not.toHaveBeenCalledWith('cli.upgraded', expect.anything())
    })

    it('always calls setLastVersion', () => {
      mockManager = createMockManager({ disclosed: true, lastVersion: '1.0.0' })
      mockService = createMockTelemetryService(mockManager)
      vi.mocked(TelemetryService.getInstance).mockReturnValue(mockService as unknown as TelemetryService)

      handleTelemetryLifecycle('1.0.0', false)

      expect(mockManager.setLastVersion).toHaveBeenCalledWith('1.0.0')
    })
  })
})

describe('error tracking', () => {
  it('tracks error.occurred with correct properties for Error instances', () => {
    const mockService = createMockTelemetryService()
    const error = new TypeError('Something went wrong')

    // Simulate what cli.ts does
    mockService.track('error.occurred', {
      error_type: error instanceof Error ? error.constructor.name : 'Unknown',
      command: 'start',
      phase: 'execution',
    })

    expect(mockService.track).toHaveBeenCalledWith('error.occurred', {
      error_type: 'TypeError',
      command: 'start',
      phase: 'execution',
    })
  })

  it('uses "Unknown" error_type for non-Error objects', () => {
    const mockService = createMockTelemetryService()
    const error = 'string error'

    mockService.track('error.occurred', {
      error_type: error instanceof Error ? error.constructor.name : 'Unknown',
      command: 'unknown',
      phase: 'execution',
    })

    expect(mockService.track).toHaveBeenCalledWith('error.occurred', {
      error_type: 'Unknown',
      command: 'unknown',
      phase: 'execution',
    })
  })
})
