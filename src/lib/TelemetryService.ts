import { PostHog } from 'posthog-node'
import { TelemetryManager } from './TelemetryManager.js'
import { logger } from '../utils/logger.js'
import type { TelemetryEventMap, TelemetryEventName } from '../types/telemetry.js'

const POSTHOG_API_KEY = 'phc_H9IRi41nQuIXs6fthwCZJ4wi6jIs2LWQkUanMSdqmj'
const POSTHOG_HOST = 'https://us.i.posthog.com'
const SHUTDOWN_TIMEOUT_MS = 1000

export class TelemetryService {
	private static instance: TelemetryService | null = null
	private client: PostHog | null = null
	private manager: TelemetryManager
	private originalConsoleError: typeof console.error | null = null
	private patchedConsoleError: ((...args: unknown[]) => void) | null = null

	constructor(manager?: TelemetryManager) {
		this.manager = manager ?? new TelemetryManager()
		if (this.manager.isEnabled()) {
			try {
				this.client = new PostHog(POSTHOG_API_KEY, {
					host: POSTHOG_HOST,
					flushAt: 1,
					flushInterval: 0,
					fetchRetryCount: 0,
					requestTimeout: 3000,
				})
				this.suppressPostHogConsoleErrors()
			} catch (error) {
				logger.debug(`TelemetryService: Failed to initialize PostHog: ${error}`)
				this.client = null
			}
		}
	}

	private static isPostHogInternalError(message: string): boolean {
		return (
			message.startsWith('Error while flushing PostHog') ||
			message.startsWith('Timed out while shutting down PostHog')
		)
	}

	private suppressPostHogConsoleErrors(): void {
		this.originalConsoleError = console.error
		const wrapper = (...args: unknown[]): void => {
			if (
				typeof args[0] === 'string' &&
				TelemetryService.isPostHogInternalError(args[0])
			) {
				logger.debug(`TelemetryService: Suppressed PostHog error: ${args[0]}`)
				return
			}
			this.originalConsoleError?.call(console, ...args)
		}
		this.patchedConsoleError = wrapper
		console.error = wrapper
	}

	private restoreConsoleError(): void {
		if (this.originalConsoleError && console.error === this.patchedConsoleError) {
			console.error = this.originalConsoleError
		}
		this.originalConsoleError = null
		this.patchedConsoleError = null
	}

	getManager(): TelemetryManager {
		return this.manager
	}

	static getInstance(): TelemetryService {
		TelemetryService.instance ??= new TelemetryService()
		return TelemetryService.instance
	}

	/**
	 * Reset singleton instance. For testing only — does not flush pending events.
	 */
	static resetInstance(): void {
		TelemetryService.instance = null
	}

	track<K extends TelemetryEventName>(event: K, properties: TelemetryEventMap[K]): void
	track(event: string, properties?: Record<string, unknown>): void
	track(event: string, properties?: Record<string, unknown>): void {
		if (!this.client) return
		try {
			this.client.capture({
				distinctId: this.manager.getDistinctId(),
				event,
				properties: { ...properties, source: 'cli' },
			})
		} catch (error) {
			logger.debug(`TelemetryService: track error: ${error}`)
		}
	}

	async shutdown(): Promise<void> {
		if (!this.client) return
		let timeoutId: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				this.client.shutdown(),
				new Promise<void>((resolve) => {
					timeoutId = globalThis.setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
				}),
			])
		} catch (error) {
			logger.debug(`TelemetryService: Shutdown error: ${error}`)
		} finally {
			if (timeoutId) globalThis.clearTimeout(timeoutId)
			this.restoreConsoleError()
		}
	}
}
