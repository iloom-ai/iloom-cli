/**
 * Zod schemas for demo verification feature
 * Part of Epic #510 - Web Project Demo Verification
 */

import { z } from 'zod'

/**
 * Helper: URL validation - only allow localhost, 127.0.0.1, or relative paths
 * Security: Prevents scripts from navigating to external/malicious URLs
 */
export const SafeUrlSchema = z.string().refine(
	(val) => {
		// Allow relative paths (start with /)
		if (val.startsWith('/')) return true

		// Parse URL and check hostname and protocol
		try {
			const url = new URL(val)
			// Only allow http/https protocols
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return false
			}
			return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
		} catch {
			return false
		}
	},
	{ message: 'URL must start with http:// or https:// and be localhost, 127.0.0.1, or a relative path starting with /' },
)

/**
 * Base schema for demo step common fields
 */
const StepBase = z.object({
	description: z.string().min(1, 'Description is required'),
})

/**
 * Schema for demo script step actions using discriminated unions
 * Each action type has specific required/optional fields
 */
export const DemoStepSchema = z.discriminatedUnion('action', [
	StepBase.extend({ action: z.literal('navigate'), target: z.string() }),
	StepBase.extend({ action: z.literal('click'), target: z.string() }),
	StepBase.extend({ action: z.literal('fill'), target: z.string(), value: z.string() }),
	StepBase.extend({ action: z.literal('press'), value: z.string() }),
	StepBase.extend({ action: z.literal('wait') }),
	StepBase.extend({ action: z.literal('screenshot') }),
])

/**
 * Schema for demo script assertions
 */
export const DemoAssertionSchema = z.object({
	type: z.enum(['textVisible', 'elementExists', 'urlMatches']),
	value: z.string().min(1, 'Assertion value is required'),
	timeout: z.number().positive().optional(),
})

/**
 * Schema for a complete demo script
 */
export const DemoScriptSchema = z.object({
	name: z.string().min(1, 'Script name is required'),
	steps: z.array(z.union([DemoStepSchema, DemoAssertionSchema])),
})

/**
 * Schema for demo settings configuration
 * Used in SettingsManager for .iloom/settings.json
 */
export const DemoSettingsSchema = z.object({
	enabled: z.boolean().default(false).describe('Enable demo verification feature'),
	headless: z.boolean().default(true).describe('Run browser in headless mode'),
	baseUrl: SafeUrlSchema.default('http://localhost:3000').describe('Base URL for the web application'),
	devServerCommand: z.string().optional().describe('Command to start the development server'),
	videoDir: z.string().default('.iloom/demos/').describe('Directory for storing demo videos/screenshots'),
	timeout: z.number().positive().default(30000).describe('Default timeout for operations in milliseconds'),
})

/**
 * Non-defaulting variant for pre-merge validation
 * Prevents Zod from polluting partial settings with default values before merge
 */
export const DemoSettingsSchemaNoDefaults = z.object({
	enabled: z.boolean().optional().describe('Enable demo verification feature'),
	headless: z.boolean().optional().describe('Run browser in headless mode'),
	baseUrl: SafeUrlSchema.optional().describe('Base URL for the web application'),
	devServerCommand: z.string().optional().describe('Command to start the development server'),
	videoDir: z.string().optional().describe('Directory for storing demo videos/screenshots'),
	timeout: z.number().positive().optional().describe('Default timeout for operations in milliseconds'),
})

// Type exports derived from schemas (alternative to types/demo.ts interfaces)
export type DemoStep = z.infer<typeof DemoStepSchema>
export type DemoAssertion = z.infer<typeof DemoAssertionSchema>
export type DemoScript = z.infer<typeof DemoScriptSchema>
export type DemoSettingsType = z.infer<typeof DemoSettingsSchema>
