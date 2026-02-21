import os from 'os'
import path from 'path'
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
	}

	private readConfig(): TelemetryConfig {
		try {
			const data = fs.readJsonSync(this.configFilePath)
			return {
				distinct_id: typeof data.distinct_id === 'string' ? data.distinct_id : '',
				enabled: typeof data.enabled === 'boolean' ? data.enabled : true,
				disclosed_at: typeof data.disclosed_at === 'string' ? data.disclosed_at : undefined,
				last_version: typeof data.last_version === 'string' ? data.last_version : undefined,
			}
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'ENOENT') {
				logger.debug('TelemetryManager: Config file not found, using defaults')
			} else {
				logger.warn(`TelemetryManager: Unexpected error reading config (${code}), using defaults`)
			}
			return { ...DEFAULT_CONFIG }
		}
	}

	private writeConfig(): void {
		try {
			fs.ensureDirSync(path.dirname(this.configFilePath))
			fs.writeJsonSync(this.configFilePath, this.config, { spaces: 2 })
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'EACCES' || code === 'EPERM') {
				logger.warn(`TelemetryManager: Permission denied writing config: ${code}`)
			} else {
				logger.debug(`TelemetryManager: Failed to write config: ${error}`)
			}
		}
	}

	getDistinctId(): string {
		if (!this.config.distinct_id) {
			this.config.distinct_id = uuidv4()
			this.writeConfig()
		}
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
		this.config.last_version = version
		this.writeConfig()
	}
}
