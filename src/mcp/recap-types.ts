/**
 * Type definitions for Loom Recap MCP Server
 *
 * The Recap MCP captures session context that scrolls away during Claude sessions:
 * - Goal: The original problem statement
 * - Entries: Decisions, insights, risks, assumptions, fixes discovered during the session
 */

/** Entry types for recap entries */
export type RecapEntryType = 'decision' | 'insight' | 'risk' | 'assumption' | 'fix' | 'other'

/** Artifact types for tracking created items */
export type RecapArtifactType = 'comment' | 'issue' | 'pr'

/** Complexity levels for task assessment */
export type RecapComplexityLevel = 'trivial' | 'simple' | 'complex'

/** Single artifact entry */
export interface RecapArtifact {
	id: string
	type: RecapArtifactType
	primaryUrl: string
	urls: Record<string, string>
	description: string
	timestamp: string
}

/** Single recap entry */
export interface RecapEntry {
	id: string
	timestamp: string
	type: RecapEntryType
	content: string
}

/** Complexity assessment for the current task */
export interface RecapComplexity {
	level: RecapComplexityLevel
	reason?: string
	timestamp: string
}

/** Recap file schema stored in ~/.config/iloom-ai/recaps/ */
export interface RecapFile {
	goal?: string | null
	complexity?: RecapComplexity | null
	entries?: RecapEntry[]
	artifacts?: RecapArtifact[]
}

/** Output for get_recap tool and CLI --json (includes filePath for file watching) */
export interface RecapOutput {
	filePath: string
	goal: string | null
	complexity: RecapComplexity | null
	entries: RecapEntry[]
	artifacts: RecapArtifact[]
}

/** Input for set_goal tool */
export interface SetGoalInput {
	goal: string
}

/** Input for add_entry tool */
export interface AddEntryInput {
	type: RecapEntryType
	content: string
}

/** Output for add_entry tool */
export interface AddEntryOutput {
	id: string
	timestamp: string
	skipped: boolean
}

/** Output for set_goal tool */
export interface SetGoalOutput {
	success: true
}

/** Input for add_artifact tool */
export interface AddArtifactInput {
	type: RecapArtifactType
	primaryUrl: string
	description: string
	id?: string
	urls?: Record<string, string>
}

/** Output for add_artifact tool */
export interface AddArtifactOutput {
	id: string
	timestamp: string
	replaced: boolean
}

/** Input for set_complexity tool */
export interface SetComplexityInput {
	complexity: RecapComplexityLevel
	reason?: string
}

/** Output for set_complexity tool */
export interface SetComplexityOutput {
	success: true
	timestamp: string
}
