/**
 * Demo verification types for web project testing
 * Part of Epic #510 - Web Project Demo Verification
 */

// Re-export types inferred from Zod schemas (single source of truth)
export type { DemoStep, DemoAssertion, DemoScript, DemoSettingsType as DemoSettings } from '../lib/DemoSchema.js'

/**
 * Actions that can be performed in a demo script step
 */
export type DemoAction = 'navigate' | 'click' | 'fill' | 'wait' | 'press' | 'screenshot'

/**
 * Assertion types for verifying demo state
 */
export type DemoAssertionType = 'textVisible' | 'elementExists' | 'urlMatches'
