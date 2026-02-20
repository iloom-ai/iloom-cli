/**
 * Loom Recap MCP Server
 *
 * Captures session context (goal, decisions, insights, risks, assumptions)
 * for the VS Code Loom Context Panel.
 *
 * Environment variables:
 * - RECAP_FILE_PATH: Complete path to the recap.json file (read/write)
 * - LOOM_METADATA_JSON: Stringified JSON of the loom metadata (parsed using LoomMetadata type)
 * - METADATA_FILE_PATH: Complete path to the loom metadata JSON file (for state transition tools)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'path'
import os from 'os'
import fs from 'fs-extra'
import { randomUUID } from 'crypto'
import type { RecapFile, RecapEntry, RecapOutput, RecapArtifact } from './recap-types.js'
import type { LoomMetadata, MetadataFile, SwarmState } from '../lib/MetadataManager.js'

interface EnvConfig {
	recapFilePath: string
	loomMetadata: LoomMetadata
	metadataFilePath: string | null
}

// Store validated config for use in tool handlers
let validatedRecapFilePath: string | null = null
let validatedLoomMetadata: LoomMetadata | null = null
let validatedMetadataFilePath: string | null = null

/**
 * Validate required environment variables
 * Exits with error if missing (matches issue-management-server.ts pattern)
 */
function validateEnvironment(): EnvConfig {
	const recapFilePath = process.env.RECAP_FILE_PATH
	const loomMetadataJson = process.env.LOOM_METADATA_JSON

	if (!recapFilePath) {
		console.error('Missing required environment variable: RECAP_FILE_PATH')
		process.exit(1)
	}
	if (!loomMetadataJson) {
		console.error('Missing required environment variable: LOOM_METADATA_JSON')
		process.exit(1)
	}

	let loomMetadata: LoomMetadata
	try {
		loomMetadata = JSON.parse(loomMetadataJson) as LoomMetadata
	} catch (error) {
		console.error('Failed to parse LOOM_METADATA_JSON:', error)
		process.exit(1)
	}

	// METADATA_FILE_PATH is optional (only needed for state transition tools)
	const metadataFilePath = process.env.METADATA_FILE_PATH ?? null

	// Store for tool handlers
	validatedRecapFilePath = recapFilePath
	validatedLoomMetadata = loomMetadata
	validatedMetadataFilePath = metadataFilePath

	return { recapFilePath, loomMetadata, metadataFilePath }
}

/**
 * Get the validated recap file path
 * Throws if called before validateEnvironment()
 */
function getRecapFilePath(): string {
	if (!validatedRecapFilePath) {
		throw new Error('RECAP_FILE_PATH not validated - validateEnvironment() must be called first')
	}
	return validatedRecapFilePath
}

/**
 * Get the validated loom metadata
 * Throws if called before validateEnvironment()
 */
export function getLoomMetadata(): LoomMetadata {
	if (!validatedLoomMetadata) {
		throw new Error('LOOM_METADATA_JSON not validated - validateEnvironment() must be called first')
	}
	return validatedLoomMetadata
}

/**
 * Get the validated metadata file path
 * Throws if METADATA_FILE_PATH was not provided
 */
function getMetadataFilePath(): string {
	if (!validatedMetadataFilePath) {
		throw new Error('METADATA_FILE_PATH not configured - state transition tools require this environment variable')
	}
	return validatedMetadataFilePath
}

/**
 * Convert worktree path to filename slug
 * Same algorithm as MetadataManager.slugifyPath() and src/utils/mcp.ts slugifyPath()
 */
function slugifyPath(worktreePath: string): string {
	let slug = worktreePath.replace(/[/\\]+$/, '')
	slug = slug.replace(/[/\\]/g, '___')
	slug = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
	return `${slug}.json`
}

/**
 * Resolve the recap file path.
 * When worktreePath is provided, derives the path dynamically.
 * Otherwise falls back to the env var default.
 */
export function resolveRecapFilePath(worktreePath?: string): string {
	if (worktreePath) {
		const recapsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'recaps')
		return path.join(recapsDir, slugifyPath(worktreePath))
	}
	return getRecapFilePath()
}

/**
 * Resolve the metadata file path.
 * When worktreePath is provided, derives the path dynamically.
 * Otherwise falls back to the env var default.
 */
export function resolveMetadataFilePath(worktreePath?: string): string {
	if (worktreePath) {
		const loomsDir = path.join(os.homedir(), '.config', 'iloom-ai', 'looms')
		return path.join(loomsDir, slugifyPath(worktreePath))
	}
	return getMetadataFilePath()
}

/**
 * Read recap file (returns empty object if not found or invalid)
 */
async function readRecapFile(filePath: string): Promise<RecapFile> {
	try {
		if (await fs.pathExists(filePath)) {
			const content = await fs.readFile(filePath, 'utf8')
			return JSON.parse(content) as RecapFile
		}
	} catch (error) {
		console.error(`Warning: Could not read recap file: ${error}`)
	}
	return {}
}

/**
 * Write recap file (ensures parent directory exists)
 */
async function writeRecapFile(filePath: string, recap: RecapFile): Promise<void> {
	await fs.ensureDir(path.dirname(filePath), { mode: 0o755 })
	await fs.writeFile(filePath, JSON.stringify(recap, null, 2), { mode: 0o644 })
}

// Initialize MCP server
const server = new McpServer({
	name: 'loom-recap',
	version: '0.1.0',
})

// Register set_goal tool
server.registerTool(
	'set_goal',
	{
		title: 'Set Goal',
		description: 'Set the initial goal (called once at session start)',
		inputSchema: {
			goal: z.string().describe('The original problem statement'),
			worktreePath: z.string().optional().describe('Optional worktree path to scope recap to a specific loom'),
		},
		outputSchema: {
			success: z.literal(true),
		},
	},
	async ({ goal, worktreePath }) => {
		const filePath = resolveRecapFilePath(worktreePath)
		const recap = await readRecapFile(filePath)
		recap.goal = goal
		await writeRecapFile(filePath, recap)
		return {
			content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
			structuredContent: { success: true },
		}
	}
)

// Register set_complexity tool
server.registerTool(
	'set_complexity',
	{
		title: 'Set Complexity',
		description: 'Set the assessed complexity of the current task',
		inputSchema: {
			complexity: z.enum(['trivial', 'simple', 'complex']).describe('Task complexity level'),
			reason: z.string().optional().describe('Brief explanation for the assessment'),
			worktreePath: z.string().optional().describe('Optional worktree path to scope recap to a specific loom'),
		},
		outputSchema: {
			success: z.literal(true),
			timestamp: z.string(),
		},
	},
	async ({ complexity, reason, worktreePath }) => {
		const filePath = resolveRecapFilePath(worktreePath)
		const recap = await readRecapFile(filePath)
		const timestamp = new Date().toISOString()
		recap.complexity = reason !== undefined ? { level: complexity, reason, timestamp } : { level: complexity, timestamp }
		await writeRecapFile(filePath, recap)
		const result = { success: true as const, timestamp }
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result,
		}
	}
)

// Register add_entry tool
server.registerTool(
	'add_entry',
	{
		title: 'Add Entry',
		description:
			'Append an entry to the recap. If an entry with the same type and content already exists, it will be skipped.',
		inputSchema: {
			type: z
				.enum(['decision', 'insight', 'risk', 'assumption', 'other'])
				.describe('Entry type'),
			content: z.string().describe('Entry content'),
			worktreePath: z.string().optional().describe('Optional worktree path to scope recap to a specific loom'),
		},
		outputSchema: {
			id: z.string(),
			timestamp: z.string(),
			skipped: z.boolean(),
		},
	},
	async ({ type, content, worktreePath }) => {
		const filePath = resolveRecapFilePath(worktreePath)
		const recap = await readRecapFile(filePath)
		recap.entries ??= []

		// Deduplication: skip if entry with same type and content exists
		const existingEntry = recap.entries.find((e) => e.type === type && e.content === content)

		if (existingEntry) {
			const result = { id: existingEntry.id, timestamp: existingEntry.timestamp, skipped: true }
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
				structuredContent: result,
			}
		}

		const entry: RecapEntry = {
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			type,
			content,
		}
		recap.entries.push(entry)
		await writeRecapFile(filePath, recap)
		const result = { id: entry.id, timestamp: entry.timestamp, skipped: false }
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result,
		}
	}
)

// Register add_artifact tool
server.registerTool(
	'add_artifact',
	{
		title: 'Add Artifact',
		description:
			'Track an artifact (comment, issue, PR) created during the session. If an artifact with the same primaryUrl already exists, it will be replaced.',
		inputSchema: {
			type: z.enum(['comment', 'issue', 'pr']).describe('Artifact type'),
			primaryUrl: z.string().url().describe('Main URL for the artifact'),
			description: z.string().describe('Brief description of the artifact'),
			id: z.string().optional().describe('Optional artifact ID (e.g., comment ID, issue number)'),
			urls: z.record(z.string()).optional().describe('Optional additional URLs (e.g., { api: "..." })'),
			worktreePath: z.string().optional().describe('Optional worktree path to scope recap to a specific loom'),
		},
		outputSchema: {
			id: z.string(),
			timestamp: z.string(),
			replaced: z.boolean(),
		},
	},
	async ({ type, primaryUrl, description, id, urls, worktreePath }) => {
		const filePath = resolveRecapFilePath(worktreePath)
		const recap = await readRecapFile(filePath)

		const artifact: RecapArtifact = {
			id: id ?? randomUUID(),
			type,
			primaryUrl,
			urls: urls ?? {},
			description,
			timestamp: new Date().toISOString(),
		}

		recap.artifacts ??= []

		// Deduplication: replace existing artifact with same primaryUrl
		const existingIndex = recap.artifacts.findIndex((a) => a.primaryUrl === primaryUrl)
		const replaced = existingIndex !== -1

		if (replaced) {
			// Preserve the original id if not explicitly provided
			const existingArtifact = recap.artifacts[existingIndex]
			if (existingArtifact) {
				artifact.id = id ?? existingArtifact.id
				recap.artifacts[existingIndex] = artifact
			}
		} else {
			recap.artifacts.push(artifact)
		}

		await writeRecapFile(filePath, recap)
		const result = { id: artifact.id, timestamp: artifact.timestamp, replaced }
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result,
		}
	}
)

// Register get_recap tool
server.registerTool(
	'get_recap',
	{
		title: 'Get Recap',
		description: 'Read current recap (for catching up or review)',
		inputSchema: {
			worktreePath: z.string().optional().describe('Optional worktree path to scope recap to a specific loom'),
		},
		outputSchema: {
			filePath: z.string(),
			goal: z.string().nullable(),
			complexity: z
				.object({
					level: z.enum(['trivial', 'simple', 'complex']),
					reason: z.string().optional(),
					timestamp: z.string(),
				})
				.nullable(),
			entries: z.array(
				z.object({
					id: z.string(),
					timestamp: z.string(),
					type: z.enum(['decision', 'insight', 'risk', 'assumption', 'other']),
					content: z.string(),
				})
			),
			artifacts: z.array(
				z.object({
					id: z.string(),
					type: z.enum(['comment', 'issue', 'pr']),
					primaryUrl: z.string(),
					urls: z.record(z.string()),
					description: z.string(),
					timestamp: z.string(),
				})
			),
		},
	},
	async ({ worktreePath }) => {
		const filePath = resolveRecapFilePath(worktreePath)
		const recap = await readRecapFile(filePath)
		// Use loom description as default goal for new/missing recap files
		// When worktreePath is provided, read metadata from the target worktree's metadata file
		let defaultGoal: string | null = null
		if (worktreePath) {
			try {
				const metaPath = resolveMetadataFilePath(worktreePath)
				if (await fs.pathExists(metaPath)) {
					const metaContent = await fs.readFile(metaPath, 'utf8')
					const meta = JSON.parse(metaContent) as MetadataFile
					defaultGoal = meta.description || null
				}
			} catch {
				// Fall through to null default goal
			}
		} else {
			defaultGoal = getLoomMetadata().description || null
		}
		const result: RecapOutput = {
			filePath,
			goal: recap.goal ?? defaultGoal,
			complexity: recap.complexity ?? null,
			entries: recap.entries ?? [],
			artifacts: recap.artifacts ?? [],
		}
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result as unknown as Record<string, unknown>,
		}
	}
)

// Zod schema for swarm state values
const swarmStateSchema = z.enum(['pending', 'in_progress', 'code_review', 'done', 'failed'])

// Register set_loom_state tool
server.registerTool(
	'set_loom_state',
	{
		title: 'Set Loom State',
		description: 'Set the swarm lifecycle state of the current loom',
		inputSchema: {
			state: swarmStateSchema.describe('The new state for the loom'),
			worktreePath: z.string().optional().describe('Optional worktree path to scope state operations to a specific loom'),
		},
		outputSchema: {
			success: z.literal(true),
			state: swarmStateSchema,
		},
	},
	async ({ state, worktreePath }) => {
		const metadataFilePath = resolveMetadataFilePath(worktreePath)

		// Read existing metadata
		let metadata: MetadataFile
		try {
			const content = await fs.readFile(metadataFilePath, 'utf8')
			metadata = JSON.parse(content) as MetadataFile
		} catch (error) {
			throw new Error(`Failed to read metadata file at ${metadataFilePath}: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Update state
		metadata.state = state as SwarmState

		// Write back
		await fs.writeFile(metadataFilePath, JSON.stringify(metadata, null, 2), { mode: 0o644 })

		const result = { success: true as const, state: state as SwarmState }
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result,
		}
	}
)

// Register get_loom_state tool
server.registerTool(
	'get_loom_state',
	{
		title: 'Get Loom State',
		description: 'Get the current swarm lifecycle state of the loom',
		inputSchema: {
			worktreePath: z.string().optional().describe('Optional worktree path to scope state operations to a specific loom'),
		},
		outputSchema: {
			state: swarmStateSchema.nullable(),
		},
	},
	async ({ worktreePath }) => {
		const metadataFilePath = resolveMetadataFilePath(worktreePath)

		// Read metadata
		let metadata: MetadataFile
		try {
			const content = await fs.readFile(metadataFilePath, 'utf8')
			metadata = JSON.parse(content) as MetadataFile
		} catch (error) {
			throw new Error(`Failed to read metadata file at ${metadataFilePath}: ${error instanceof Error ? error.message : String(error)}`)
		}

		const result = { state: metadata.state ?? null }
		return {
			content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			structuredContent: result,
		}
	}
)

// Main server startup
async function main(): Promise<void> {
	console.error('=== Loom Recap MCP Server Starting ===')
	console.error(`PID: ${process.pid}`)
	console.error(`Node version: ${process.version}`)
	console.error(`CWD: ${process.cwd()}`)
	console.error(`Script: ${new URL(import.meta.url).pathname}`)

	// Log relevant env vars (LOOM_METADATA_JSON is large, just log presence and length)
	console.error('Environment variables:')
	console.error(`  RECAP_FILE_PATH=${process.env.RECAP_FILE_PATH ?? '<not set>'}`)
	console.error(`  METADATA_FILE_PATH=${process.env.METADATA_FILE_PATH ?? '<not set>'}`)
	console.error(`  LOOM_METADATA_JSON=${process.env.LOOM_METADATA_JSON ? `<set, ${process.env.LOOM_METADATA_JSON.length} chars>` : '<not set>'}`)

	const { recapFilePath, loomMetadata, metadataFilePath } = validateEnvironment()
	console.error(`Recap file path: ${recapFilePath}`)
	console.error(`Metadata file path: ${metadataFilePath ?? '<not configured>'}`)
	console.error(`Loom: ${loomMetadata.description} (branch: ${loomMetadata.branchName})`)

	// Check if recap file already exists
	const recapExists = await fs.pathExists(recapFilePath)
	console.error(`Recap file exists: ${recapExists}`)

	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('=== Loom Recap MCP Server READY (stdio transport) ===')
}

main().catch((error) => {
	console.error('Fatal error starting MCP server:', error)
	process.exit(1)
})
