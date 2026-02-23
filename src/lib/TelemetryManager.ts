import os from 'os'
import path from 'path'
import nodeFs from 'node:fs'
import fs from 'fs-extra'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../utils/logger.js'
import type { TelemetryConfig } from '../types/telemetry.js'

const DEFAULT_CONFIG: TelemetryConfig = { distinct_id: '', enabled: true }
const CONFIG_FILE = 'telemetry.json'

export class TelemetryManager {
	private configFilePath: string
	private config: TelemetryConfig

	constructor(configDir?: string) {
		const dir = configDir ?? path.join(os.homedir(), '.config', 'iloom-ai')
		this.configFilePath = path.join(dir, CONFIG_FILE)
		this.config = this.readConfig()
		if (!this.config.distinct_id) {
			this.config.distinct_id = uuidv4()
			// Re-read to check if another concurrent process already wrote a distinct_id
			// between our first read and now. Prefer the existing one for consistency.
			const freshConfig = this.readConfig()
			if (freshConfig.distinct_id) {
				this.config = freshConfig
			} else {
				// NOTE: There is an accepted residual race condition on first-ever file creation.
				// If N processes all see ENOENT before any of them writes, each will generate a
				// different UUID. This only affects the very first invocation on a new machine and
				// subsequent invocations will read the persisted ID, so the impact is negligible.
				freshConfig.distinct_id = this.config.distinct_id
				this.config = freshConfig
				this.writeConfig()
			}
		}
	}

	private readConfig(): TelemetryConfig {
		try {
			const data = fs.readJsonSync(this.configFilePath)
			if (!data || typeof data !== 'object' || Array.isArray(data)) {
				throw new Error('Invalid config format: expected a JSON object')
			}
			return {
				distinct_id: typeof data.distinct_id === 'string' ? data.distinct_id : '',
				enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
				...(typeof data.disclosed_at === 'string' ? { disclosed_at: data.disclosed_at } : {}),
				...(typeof data.last_version === 'string' ? { last_version: data.last_version } : {}),
			}
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'ENOENT') {
				logger.debug('TelemetryManager: Config file not found, using defaults')
				return { ...DEFAULT_CONFIG }
			}
			// Corrupted/unreadable file: disable telemetry to respect user opt-out
			logger.warn(`TelemetryManager: Unexpected error reading config (${code ?? error}), disabling telemetry`)
			return { ...DEFAULT_CONFIG, enabled: false }
		}
	}

	private writeConfig(): void {
		try {
			const dir = path.dirname(this.configFilePath)
			fs.ensureDirSync(dir)
			// Atomic write: write to a temp file in the same directory, then rename.
			// renameSync is atomic on the same filesystem, so concurrent readers will
			// either see the old file or the new file, never a partially-written one.
			const tmpPath = `${this.configFilePath}.${process.pid}.tmp`
			const data = JSON.stringify(this.config, null, 2)
			nodeFs.writeFileSync(tmpPath, data, 'utf8')
			nodeFs.renameSync(tmpPath, this.configFilePath)
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'EACCES' || code === 'EPERM') {
				logger.warn(`TelemetryManager: Permission denied writing config: ${code}`)
			} else {
				logger.debug(`TelemetryManager: Failed to write config: ${error}`)
			}
			// Clean up temp file if it exists
			try {
				const tmpPath = `${this.configFilePath}.${process.pid}.tmp`
				nodeFs.unlinkSync(tmpPath)
			} catch (cleanupError: unknown) {
				const cleanupCode = (cleanupError as NodeJS.ErrnoException).code
				if (cleanupCode !== 'ENOENT') {
					logger.debug(`TelemetryManager: Failed to clean up temp file: ${cleanupError}`)
				}
			}
		}
	}

	getDistinctId(): string {
		return this.config.distinct_id
	}

	isEnabled(): boolean {
		return this.config.enabled
	}

	enable(): void {
		this.config.enabled = true
		this.writeConfig()
	}

	disable(): void {
		this.config.enabled = false
		this.writeConfig()
	}

	getStatus(): { enabled: boolean; distinctId: string } {
		return { enabled: this.isEnabled(), distinctId: this.getDistinctId() }
	}

	hasBeenDisclosed(): boolean {
		return this.config.disclosed_at !== undefined && this.config.disclosed_at !== ''
	}

	markDisclosed(): void {
		this.config.disclosed_at = new Date().toISOString()
		this.writeConfig()
	}

	getLastVersion(): string | null {
		return this.config.last_version ?? null
	}

	setLastVersion(version: string): void {
		if (this.config.last_version === version) return
		this.config.last_version = version
		this.writeConfig()
	}
}
