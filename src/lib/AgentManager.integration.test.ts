import { describe, it, expect } from 'vitest'
import path from 'path'
import { AgentManager } from './AgentManager.js'
import { PromptTemplateManager } from './PromptTemplateManager.js'

/**
 * Integration test for AgentManager + PromptTemplateManager + real agent templates.
 *
 * These tests read the actual agent markdown files from templates/agents/,
 * run real Handlebars substitution, and verify the end-to-end result of
 * frontmatter parsing with template variables.
 */

// Resolve the real templates/agents/ directory relative to the project root
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..')
const AGENTS_DIR = path.join(PROJECT_ROOT, 'templates', 'agents')
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'templates', 'prompts')

// All agent names expected in the templates/agents/ directory
const ALL_AGENT_NAMES = [
	'iloom-artifact-reviewer',
	'iloom-code-reviewer',
	'iloom-framework-detector',
	'iloom-issue-analyze-and-plan',
	'iloom-issue-analyzer',
	'iloom-issue-complexity-evaluator',
	'iloom-issue-enhancer',
	'iloom-issue-implementer',
	'iloom-issue-planner',
	'iloom-wave-verifier',
]

describe('AgentManager integration (real templates)', () => {
	// Use real PromptTemplateManager and real agent files
	const templateManager = new PromptTemplateManager(PROMPTS_DIR)

	describe('loadAgents with SWARM_MODE=true', () => {
		it('should load all agents successfully', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: true })

			const loadedNames = Object.keys(agents).sort()
			expect(loadedNames).toEqual(ALL_AGENT_NAMES)
		})

		it('should resolve swarm-mode model overrides from Handlebars conditionals', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: true })

			// Agents with conditional model: sonnet in swarm mode
			expect(agents['iloom-issue-implementer'].model).toBe('sonnet')
			expect(agents['iloom-issue-planner'].model).toBe('sonnet')
			expect(agents['iloom-issue-enhancer'].model).toBe('sonnet')
			expect(agents['iloom-code-reviewer'].model).toBe('sonnet')

			// Agents with unconditional model (always opus regardless of mode)
			expect(agents['iloom-issue-analyzer'].model).toBe('opus')
			expect(agents['iloom-issue-analyze-and-plan'].model).toBe('opus')
			expect(agents['iloom-wave-verifier'].model).toBe('opus')
			expect(agents['iloom-framework-detector'].model).toBe('opus')
			expect(agents['iloom-artifact-reviewer'].model).toBe('opus')
			expect(agents['iloom-issue-complexity-evaluator'].model).toBe('haiku')
		})

		it('should resolve swarm-mode effort defaults from Handlebars conditionals', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: true })

			// Agents with conditional effort: {{#if SWARM_MODE}}effort: <level>{{/if}}
			expect(agents['iloom-issue-analyzer'].effort).toBe('high')
			expect(agents['iloom-issue-planner'].effort).toBe('high')
			expect(agents['iloom-issue-implementer'].effort).toBe('medium')
			expect(agents['iloom-issue-enhancer'].effort).toBe('medium')
			expect(agents['iloom-code-reviewer'].effort).toBe('medium')
			expect(agents['iloom-issue-complexity-evaluator'].effort).toBe('high')
			expect(agents['iloom-issue-analyze-and-plan'].effort).toBe('high')

			// Agents with unconditional effort (always set regardless of SWARM_MODE)
			expect(agents['iloom-wave-verifier'].effort).toBe('high')
			expect(agents['iloom-framework-detector'].effort).toBe('high')

			// Agents with no effort field at all
			expect(agents['iloom-artifact-reviewer'].effort).toBeUndefined()
		})

		it('should have non-empty prompts for all agents', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: true })

			for (const [name, config] of Object.entries(agents)) {
				expect(config.prompt.length, `${name} should have a non-empty prompt`).toBeGreaterThan(0)
			}
		})

		it('should have non-empty descriptions for all agents', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: true })

			for (const [name, config] of Object.entries(agents)) {
				expect(config.description.length, `${name} should have a non-empty description`).toBeGreaterThan(0)
			}
		})
	})

	describe('loadAgents with SWARM_MODE=false (non-swarm)', () => {
		it('should load all agents successfully', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: false })

			const loadedNames = Object.keys(agents).sort()
			expect(loadedNames).toEqual(ALL_AGENT_NAMES)
		})

		it('should resolve non-swarm model defaults', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: false })

			// Agents with conditional model resolve to opus in non-swarm mode
			expect(agents['iloom-issue-implementer'].model).toBe('opus')
			expect(agents['iloom-issue-planner'].model).toBe('opus')
			expect(agents['iloom-issue-enhancer'].model).toBe('opus')
			expect(agents['iloom-code-reviewer'].model).toBe('opus')

			// Agents with unconditional model are the same regardless of mode
			expect(agents['iloom-issue-analyzer'].model).toBe('opus')
			expect(agents['iloom-issue-analyze-and-plan'].model).toBe('opus')
			expect(agents['iloom-wave-verifier'].model).toBe('opus')
			expect(agents['iloom-framework-detector'].model).toBe('opus')
			expect(agents['iloom-artifact-reviewer'].model).toBe('opus')
			expect(agents['iloom-issue-complexity-evaluator'].model).toBe('haiku')
		})

		it('should have undefined effort for agents that only set effort in swarm mode', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents(undefined, { SWARM_MODE: false })

			// These agents use {{#if SWARM_MODE}}effort: <level>{{/if}} - resolves to empty/undefined
			expect(agents['iloom-issue-analyzer'].effort).toBeUndefined()
			expect(agents['iloom-issue-planner'].effort).toBeUndefined()
			expect(agents['iloom-issue-implementer'].effort).toBeUndefined()
			expect(agents['iloom-issue-enhancer'].effort).toBeUndefined()
			expect(agents['iloom-code-reviewer'].effort).toBeUndefined()
			expect(agents['iloom-issue-complexity-evaluator'].effort).toBeUndefined()
			expect(agents['iloom-issue-analyze-and-plan'].effort).toBeUndefined()

			// These agents have unconditional effort - always present
			expect(agents['iloom-wave-verifier'].effort).toBe('high')
			expect(agents['iloom-framework-detector'].effort).toBe('high')

			// No effort field at all
			expect(agents['iloom-artifact-reviewer'].effort).toBeUndefined()
		})
	})

	describe('loadAgents without templateVariables (no substitution)', () => {
		it('should load all agents successfully even without template variables', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)
			const agents = await manager.loadAgents()

			const loadedNames = Object.keys(agents).sort()
			expect(loadedNames).toEqual(ALL_AGENT_NAMES)
		})
	})

	describe('swarm vs non-swarm model differences', () => {
		it('should produce different models for swarm-conditional agents', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)

			const swarmAgents = await manager.loadAgents(undefined, { SWARM_MODE: true })
			const nonSwarmAgents = await manager.loadAgents(undefined, { SWARM_MODE: false })

			// Agents that change model between swarm and non-swarm
			const conditionalModelAgents = [
				'iloom-issue-implementer',
				'iloom-issue-planner',
				'iloom-issue-enhancer',
				'iloom-code-reviewer',
			]

			for (const name of conditionalModelAgents) {
				expect(
					swarmAgents[name].model,
					`${name} swarm model should be sonnet`,
				).toBe('sonnet')
				expect(
					nonSwarmAgents[name].model,
					`${name} non-swarm model should be opus`,
				).toBe('opus')
			}
		})

		it('should produce different effort levels for swarm-conditional agents', async () => {
			const manager = new AgentManager(AGENTS_DIR, templateManager)

			const swarmAgents = await manager.loadAgents(undefined, { SWARM_MODE: true })
			const nonSwarmAgents = await manager.loadAgents(undefined, { SWARM_MODE: false })

			// Agents that only have effort in swarm mode
			const conditionalEffortAgents = [
				'iloom-issue-analyzer',
				'iloom-issue-planner',
				'iloom-issue-implementer',
				'iloom-issue-enhancer',
				'iloom-code-reviewer',
				'iloom-issue-complexity-evaluator',
				'iloom-issue-analyze-and-plan',
			]

			for (const name of conditionalEffortAgents) {
				expect(
					swarmAgents[name].effort,
					`${name} should have effort in swarm mode`,
				).toBeDefined()
				expect(
					nonSwarmAgents[name].effort,
					`${name} should NOT have effort in non-swarm mode`,
				).toBeUndefined()
			}
		})
	})
})
