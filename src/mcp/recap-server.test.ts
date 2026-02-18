import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'
import type { RecapFile, RecapEntry } from './recap-types.js'
import type { MetadataFile, SwarmState } from '../lib/MetadataManager.js'

/**
 * Since the recap-server.ts registers MCP tools directly on module load,
 * we need to test the deduplication logic by simulating what the handler does.
 * This approach tests the business logic without coupling to the MCP server internals.
 */

// Mock UUID generator for deterministic tests
const mockUUID = vi.fn()

/**
 * Simulates the add_entry deduplication logic from recap-server.ts lines 185-213
 */
async function addEntryWithDeduplication(
	readRecap: () => Promise<RecapFile>,
	writeRecap: (recap: RecapFile) => Promise<void>,
	type: RecapEntry['type'],
	content: string
): Promise<{ id: string; timestamp: string; skipped: boolean }> {
	const recap = await readRecap()
	recap.entries ??= []

	// Deduplication: skip if entry with same type and content exists
	const existingEntry = recap.entries.find((e) => e.type === type && e.content === content)

	if (existingEntry) {
		return { id: existingEntry.id, timestamp: existingEntry.timestamp, skipped: true }
	}

	const entry: RecapEntry = {
		id: mockUUID(),
		timestamp: new Date().toISOString(),
		type,
		content,
	}
	recap.entries.push(entry)
	await writeRecap(recap)
	return { id: entry.id, timestamp: entry.timestamp, skipped: false }
}

describe('recap-server add_entry deduplication', () => {
	let mockRecapFile: RecapFile
	let readRecapMock: () => Promise<RecapFile>
	let writeRecapMock: (recap: RecapFile) => Promise<void>

	beforeEach(() => {
		// Reset mock recap file before each test
		mockRecapFile = { entries: [] }

		// Reset mock UUID to return a deterministic value
		mockUUID.mockReturnValue('test-uuid-123')

		// Create mock functions that operate on mockRecapFile
		readRecapMock = vi.fn().mockImplementation(async () => ({ ...mockRecapFile, entries: [...(mockRecapFile.entries ?? [])] }))
		writeRecapMock = vi.fn().mockImplementation(async (recap: RecapFile) => {
			mockRecapFile = { ...recap, entries: [...(recap.entries ?? [])] }
		})
	})

	describe('when adding a new entry with unique type and content', () => {
		it('should create a new entry and return skipped: false', async () => {
			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'decision',
				'Use TypeScript for the implementation'
			)

			expect(result.skipped).toBe(false)
			expect(result.id).toBe('test-uuid-123')
			expect(result.timestamp).toBeDefined()
			expect(writeRecapMock).toHaveBeenCalled()
		})

		it('should add the entry to the entries array', async () => {
			await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'insight',
				'Found existing helper function'
			)

			expect(mockRecapFile.entries).toHaveLength(1)
			expect(mockRecapFile.entries?.[0]).toMatchObject({
				type: 'insight',
				content: 'Found existing helper function',
			})
		})
	})

	describe('when adding an entry with duplicate type and content', () => {
		it('should skip adding duplicate and return skipped: true', async () => {
			// Pre-populate with existing entry
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'decision',
				content: 'Use TypeScript for the implementation',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'decision',
				'Use TypeScript for the implementation'
			)

			expect(result.skipped).toBe(true)
			expect(result.id).toBe('existing-uuid-456')
			expect(result.timestamp).toBe('2025-01-01T00:00:00Z')
		})

		it('should return the existing entry id and timestamp', async () => {
			const existingEntry: RecapEntry = {
				id: 'original-id-789',
				timestamp: '2025-06-15T12:30:00Z',
				type: 'risk',
				content: 'Potential performance issue with large datasets',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'risk',
				'Potential performance issue with large datasets'
			)

			expect(result.id).toBe('original-id-789')
			expect(result.timestamp).toBe('2025-06-15T12:30:00Z')
		})

		it('should not modify the entries array', async () => {
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'assumption',
				content: 'Database will be available',
			}
			mockRecapFile = { entries: [existingEntry] }

			await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'assumption',
				'Database will be available'
			)

			expect(mockRecapFile.entries).toHaveLength(1)
			expect(writeRecapMock).not.toHaveBeenCalled()
		})
	})

	describe('when adding an entry with same type but different content', () => {
		it('should add the new entry', async () => {
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'decision',
				content: 'Use TypeScript for the implementation',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'decision',
				'Use Vitest for testing'
			)

			expect(result.skipped).toBe(false)
			expect(mockRecapFile.entries).toHaveLength(2)
		})

		it('should return skipped: false', async () => {
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'insight',
				content: 'First insight',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'insight',
				'Second insight'
			)

			expect(result.skipped).toBe(false)
		})
	})

	describe('when adding an entry with different type but same content', () => {
		it('should add the new entry', async () => {
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'insight',
				content: 'The system uses event-driven architecture',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'decision',
				'The system uses event-driven architecture'
			)

			expect(result.skipped).toBe(false)
			expect(mockRecapFile.entries).toHaveLength(2)
		})

		it('should return skipped: false', async () => {
			const existingEntry: RecapEntry = {
				id: 'existing-uuid-456',
				timestamp: '2025-01-01T00:00:00Z',
				type: 'risk',
				content: 'API rate limits may be exceeded',
			}
			mockRecapFile = { entries: [existingEntry] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'assumption',
				'API rate limits may be exceeded'
			)

			expect(result.skipped).toBe(false)
		})
	})

	describe('when entries array is empty or undefined', () => {
		it('should add entry when entries array is empty', async () => {
			mockRecapFile = { entries: [] }

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'other',
				'Some other entry'
			)

			expect(result.skipped).toBe(false)
			expect(mockRecapFile.entries).toHaveLength(1)
		})

		it('should initialize entries array when undefined', async () => {
			mockRecapFile = {}

			const result = await addEntryWithDeduplication(
				readRecapMock,
				writeRecapMock,
				'decision',
				'First decision'
			)

			expect(result.skipped).toBe(false)
			expect(mockRecapFile.entries).toHaveLength(1)
		})
	})
})

/**
 * Simulates the set_loom_state logic from recap-server.ts
 * Reads metadata file, updates state, writes back
 */
async function setLoomState(
	readMetadata: () => Promise<MetadataFile>,
	writeMetadata: (metadata: MetadataFile) => Promise<void>,
	state: SwarmState
): Promise<{ success: true; state: SwarmState }> {
	const metadata = await readMetadata()
	metadata.state = state
	await writeMetadata(metadata)
	return { success: true, state }
}

/**
 * Simulates the get_loom_state logic from recap-server.ts
 * Reads metadata file, returns current state
 */
async function getLoomState(
	readMetadata: () => Promise<MetadataFile>
): Promise<{ state: SwarmState | null }> {
	const metadata = await readMetadata()
	return { state: metadata.state ?? null }
}

describe('recap-server state transition tools', () => {
	let mockMetadataFile: MetadataFile
	let readMetadataMock: () => Promise<MetadataFile>
	let writeMetadataMock: (metadata: MetadataFile) => Promise<void>

	beforeEach(() => {
		mockMetadataFile = {
			description: 'Test loom',
			version: 1,
			branchName: 'issue-42__test',
			worktreePath: '/Users/test/dev/repo',
		}

		readMetadataMock = vi.fn().mockImplementation(async () => ({ ...mockMetadataFile }))
		writeMetadataMock = vi.fn().mockImplementation(async (metadata: MetadataFile) => {
			mockMetadataFile = { ...metadata }
		})
	})

	describe('set_loom_state', () => {
		it('should set state to in_progress', async () => {
			const result = await setLoomState(readMetadataMock, writeMetadataMock, 'in_progress')

			expect(result.success).toBe(true)
			expect(result.state).toBe('in_progress')
			expect(mockMetadataFile.state).toBe('in_progress')
		})

		it('should set state to code_review', async () => {
			const result = await setLoomState(readMetadataMock, writeMetadataMock, 'code_review')

			expect(result.state).toBe('code_review')
			expect(mockMetadataFile.state).toBe('code_review')
		})

		it('should set state to done', async () => {
			const result = await setLoomState(readMetadataMock, writeMetadataMock, 'done')

			expect(result.state).toBe('done')
			expect(mockMetadataFile.state).toBe('done')
		})

		it('should set state to failed', async () => {
			const result = await setLoomState(readMetadataMock, writeMetadataMock, 'failed')

			expect(result.state).toBe('failed')
			expect(mockMetadataFile.state).toBe('failed')
		})

		it('should overwrite existing state', async () => {
			mockMetadataFile.state = 'pending'

			const result = await setLoomState(readMetadataMock, writeMetadataMock, 'in_progress')

			expect(result.state).toBe('in_progress')
			expect(mockMetadataFile.state).toBe('in_progress')
		})

		it('should preserve other metadata fields when setting state', async () => {
			mockMetadataFile.description = 'Important loom'
			mockMetadataFile.branchName = 'issue-99__feature'

			await setLoomState(readMetadataMock, writeMetadataMock, 'done')

			expect(mockMetadataFile.description).toBe('Important loom')
			expect(mockMetadataFile.branchName).toBe('issue-99__feature')
			expect(mockMetadataFile.state).toBe('done')
		})

		it('should call writeMetadata with updated metadata', async () => {
			await setLoomState(readMetadataMock, writeMetadataMock, 'pending')

			expect(writeMetadataMock).toHaveBeenCalledWith(
				expect.objectContaining({ state: 'pending' })
			)
		})
	})

	describe('get_loom_state', () => {
		it('should return current state when set', async () => {
			mockMetadataFile.state = 'in_progress'

			const result = await getLoomState(readMetadataMock)

			expect(result.state).toBe('in_progress')
		})

		it('should return null when state is not set', async () => {
			// mockMetadataFile has no state field by default

			const result = await getLoomState(readMetadataMock)

			expect(result.state).toBeNull()
		})

		it('should return each valid state value', async () => {
			const states: SwarmState[] = ['pending', 'in_progress', 'code_review', 'done', 'failed']

			for (const state of states) {
				mockMetadataFile.state = state
				const result = await getLoomState(readMetadataMock)
				expect(result.state).toBe(state)
			}
		})
	})
})

/**
 * Replicates the slugifyPath logic from recap-server.ts for testing
 * Same algorithm as MetadataManager.slugifyPath() and src/utils/mcp.ts slugifyPath()
 */
function slugifyPath(worktreePath: string): string {
	let slug = worktreePath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Replicates the resolveRecapFilePath logic from recap-server.ts
 * When worktreePath is provided, derives the path dynamically.
 * Otherwise falls back to the env var default.
 */
function resolveRecapFilePath(worktreePath: string | undefined, envDefault: string): string {
	if (worktreePath) {
		const recapsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')
		return path.join(recapsDir, slugifyPath(worktreePath))
	}
	return envDefault
}

/**
 * Replicates the resolveMetadataFilePath logic from recap-server.ts
 * When worktreePath is provided, derives the path dynamically.
 * Otherwise falls back to the env var default.
 */
function resolveMetadataFilePath(worktreePath: string | undefined, envDefault: string): string {
	if (worktreePath) {
		const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')
		return path.join(loomsDir, slugifyPath(worktreePath))
	}
	return envDefault
}

describe('recap-server worktreePath resolution', () => {
	const envRecapPath = '/home/user/.config/iloom-ai/recaps/existing.json'
	const envMetadataPath = '/home/user/.config/iloom-ai/looms/existing.json'

	describe('slugifyPath', () => {
		it('should convert a Unix worktree path to a slug', () => {
			const result = slugifyPath('/Users/jane/dev/repo')
			expect(result).toBe('___Users___jane___dev___repo.json')
		})

		it('should trim trailing slashes', () => {
			const result = slugifyPath('/Users/jane/dev/repo/')
			expect(result).toBe('___Users___jane___dev___repo.json')
		})

		it('should handle paths with special characters', () => {
			const result = slugifyPath('/Users/jane/my project/repo')
			expect(result).toBe('___Users___jane___my-project___repo.json')
		})

		it('should handle paths with dots', () => {
			const result = slugifyPath('/Users/jane/.config/repo')
			expect(result).toBe('___Users___jane___-config___repo.json')
		})

		it('should preserve hyphens and underscores', () => {
			const result = slugifyPath('/Users/jane/my-repo_v2')
			expect(result).toBe('___Users___jane___my-repo_v2.json')
		})
	})

	describe('resolveRecapFilePath', () => {
		it('should return env default when worktreePath is undefined', () => {
			const result = resolveRecapFilePath(undefined, envRecapPath)
			expect(result).toBe(envRecapPath)
		})

		it('should derive path from worktreePath when provided', () => {
			const worktreePath = '/Users/jane/dev/repo'
			const result = resolveRecapFilePath(worktreePath, envRecapPath)

			const expected = path.join(
				os.homedir(),
				'.config',
				'iloom-ai',
				'recaps',
				'___Users___jane___dev___repo.json'
			)
			expect(result).toBe(expected)
		})

		it('should not use env default when worktreePath is provided', () => {
			const result = resolveRecapFilePath('/some/path', envRecapPath)
			expect(result).not.toBe(envRecapPath)
		})

		it('should produce different paths for different worktrees', () => {
			const result1 = resolveRecapFilePath('/Users/jane/project-a', envRecapPath)
			const result2 = resolveRecapFilePath('/Users/jane/project-b', envRecapPath)
			expect(result1).not.toBe(result2)
		})
	})

	describe('resolveMetadataFilePath', () => {
		it('should return env default when worktreePath is undefined', () => {
			const result = resolveMetadataFilePath(undefined, envMetadataPath)
			expect(result).toBe(envMetadataPath)
		})

		it('should derive path from worktreePath when provided', () => {
			const worktreePath = '/Users/jane/dev/repo'
			const result = resolveMetadataFilePath(worktreePath, envMetadataPath)

			const expected = path.join(
				os.homedir(),
				'.config',
				'iloom-ai',
				'looms',
				'___Users___jane___dev___repo.json'
			)
			expect(result).toBe(expected)
		})

		it('should use looms directory not recaps directory', () => {
			const result = resolveMetadataFilePath('/Users/jane/dev/repo', envMetadataPath)
			expect(result).toContain('/looms/')
			expect(result).not.toContain('/recaps/')
		})

		it('should not use env default when worktreePath is provided', () => {
			const result = resolveMetadataFilePath('/some/path', envMetadataPath)
			expect(result).not.toBe(envMetadataPath)
		})
	})

	describe('recap and metadata paths use same slug for same worktree', () => {
		it('should produce the same filename for both recap and metadata paths', () => {
			const worktreePath = '/Users/jane/dev/feature-branch'
			const recapPath = resolveRecapFilePath(worktreePath, envRecapPath)
			const metadataPath = resolveMetadataFilePath(worktreePath, envMetadataPath)

			// Same filename, different directory
			expect(path.basename(recapPath)).toBe(path.basename(metadataPath))
			expect(path.dirname(recapPath)).not.toBe(path.dirname(metadataPath))
		})
	})
})
