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

	constructor(manager?: TelemetryManager) {
		this.manager = manager ?? new TelemetryManager()
		if (this.manager.isEnabled()) {
			try {
				this.client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST })
			} catch (error) {
				logger.debug(`TelemetryService: Failed to initialize PostHog: ${error}`)
				this.client = null
			}
		}
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
		try {
			await Promise.race([
				this.client.shutdown(),
				new Promise<void>((resolve) => globalThis.setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
			])
		} catch (error) {
			logger.debug(`TelemetryService: Shutdown error: ${error}`)
		}
	}
}
