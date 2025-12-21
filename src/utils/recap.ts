import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import type { RecapFile } from '../mcp/recap-types.js'
import { logger } from './logger.js'

const RECAPS_DIR = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')

/**
 * Reuse MetadataManager.slugifyPath() algorithm for recap file naming
 *
 * Algorithm:
 * 1. Trim trailing slashes
 * 2. Replace all path separators (/ or \) with ___ (triple underscore)
 * 3. Replace any other non-alphanumeric characters (except _ and -) with -
 * 4. Append .json
 */
export function slugifyRecapPath(loomPath: string): string {
	let slug = loomPath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

export function getRecapFilePath(loomPath: string): string {
	return path.join(RECAPS_DIR, slugifyRecapPath(loomPath))
}

function hasRecapContent(recap: RecapFile | null): boolean {
	if (!recap) {
		return false
	}

	if (recap.goal) {
		return true
	}

	if (recap.complexity) {
		return true
	}

	if (recap.entries && recap.entries.length > 0) {
		return true
	}

	if (recap.artifacts && recap.artifacts.length > 0) {
		return true
	}

	return false
}

export async function readRecapFile(loomPath: string): Promise<RecapFile | null> {
	const filePath = getRecapFilePath(loomPath)

	try {
		if (!(await fs.pathExists(filePath))) {
			return null
		}

		const content = await fs.readFile(filePath, 'utf8')
		return JSON.parse(content) as RecapFile
	} catch (error) {
		logger.debug('Failed to read recap file', { filePath, error })
		return null
	}
}

export async function readRecapForPrompt(loomPath: string): Promise<string> {
	const recap = await readRecapFile(loomPath)

	if (!hasRecapContent(recap)) {
		return ''
	}

	return JSON.stringify(recap, null, 2)
}
