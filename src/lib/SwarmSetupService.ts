import path from 'path'
import fs from 'fs-extra'
import { fileURLToPath } from 'url'
import { GitWorktreeManager } from './GitWorktreeManager.js'
import { MetadataManager, type WriteMetadataInput, type SwarmState } from './MetadataManager.js'
import { AgentManager } from './AgentManager.js'
import { SettingsManager } from './SettingsManager.js'
import type { TemplateVariables } from './PromptTemplateManager.js'
import { getLogger } from '../utils/logger-context.js'
import { installDependencies } from '../utils/package-manager.js'
import { generateWorktreePath } from '../utils/git.js'

/**
 * Result of the swarm setup process
 */
export interface SwarmSetupResult {
	epicWorktreePath: string
	epicBranch: string
	childWorktrees: Array<{
		issueId: string
		worktreePath: string
		branch: string
		success: boolean
		error?: string
	}>
	agentsRendered: string[]
	skillRendered: boolean
}

/**
 * Child issue data as stored in epic metadata
 */
export interface SwarmChildIssue {
	number: string   // Prefixed: "#123" for GitHub, "ENG-123" for Linear
	title: string
	body: string
	url: string
}

/**
 * SwarmSetupService handles the creation of child worktrees
 * for swarm mode, plus rendering swarm-mode agents and skill files.
 *
 * Called from the spin command (ignite.ts) when an epic loom is detected.
 * The epic worktree already exists (created by `il start`).
 */
export class SwarmSetupService {
	constructor(
		private gitWorktree: GitWorktreeManager,
		private metadataManager: MetadataManager,
		private agentManager: AgentManager,
		private settingsManager: SettingsManager,
	) {}

	/**
	 * Create child worktrees for each child issue, branched off the epic branch.
	 * Writes iloom-metadata.json for each child with state: 'pending' and parentLoom.
	 *
	 * Uses standard iloom naming conventions via generateWorktreePath().
	 *
	 * @param childIssues - Array of child issues from epic metadata
	 * @param epicBranch - The epic branch name (base branch for children)
	 * @param epicWorktreePath - Path to the epic worktree
	 * @param mainWorktreePath - Path to the main worktree (project root)
	 * @param epicIssueNumber - The parent epic issue number
	 * @param issueTrackerName - The issue tracker provider name (e.g., 'github')
	 * @returns Array of results for each child worktree creation
	 */
	async createChildWorktrees(
		childIssues: SwarmChildIssue[],
		epicBranch: string,
		epicWorktreePath: string,
		mainWorktreePath: string,
		epicIssueNumber: string | number,
		issueTrackerName: string,
	): Promise<SwarmSetupResult['childWorktrees']> {
		const results: SwarmSetupResult['childWorktrees'] = []

		for (const child of childIssues) {
			try {
				// Strip prefix from child number (e.g., "#123" -> "123", "ENG-123" stays as-is for branch naming)
				const rawId = child.number.replace(/^#/, '')

				// Sanitize ID for safe git branch naming (replace non-alphanumeric except - and _ with -)
				const safeId = rawId.replace(/[^a-zA-Z0-9-_]/g, '-')

				// Use standard iloom branch naming: issue/<id> pattern
				const childBranch = `issue/${safeId}`

				// Use standard iloom worktree path generation
				const childWorktreePath = generateWorktreePath(
					childBranch,
					mainWorktreePath,
				)

				getLogger().info(`Creating child worktree for ${child.number}: ${childWorktreePath}...`)

				await this.gitWorktree.createWorktree({
					path: childWorktreePath,
					branch: childBranch,
					createBranch: true,
					baseBranch: epicBranch,
				})

				// Write metadata with state: 'pending' and parentLoom
				const metadataInput: WriteMetadataInput = {
					description: child.title,
					branchName: childBranch,
					worktreePath: childWorktreePath,
					issueType: 'issue',
					issue_numbers: [rawId],
					pr_numbers: [],
					issueTracker: issueTrackerName,
					colorHex: '#808080',
					sessionId: '', // No session - not launching Claude directly
					projectPath: mainWorktreePath,
					issueUrls: { [rawId]: child.url },
					prUrls: {},
					capabilities: [],
					state: 'pending' as SwarmState,
					parentLoom: {
						type: 'epic',
						identifier: epicIssueNumber,
						branchName: epicBranch,
						worktreePath: epicWorktreePath,
					},
				}

				try {
					await this.metadataManager.writeMetadata(childWorktreePath, metadataInput)
				} catch (metaError) {
					// Clean up the worktree to avoid zombie worktrees without metadata
					getLogger().warn(`Metadata write failed for ${child.number}, cleaning up worktree...`)
					try {
						await this.gitWorktree.removeWorktree(childWorktreePath, { force: true })
					} catch {
						getLogger().debug(`Could not clean up worktree at ${childWorktreePath}`)
					}
					throw metaError
				}

				// Install dependencies in the child worktree
				try {
					await installDependencies(childWorktreePath, true, true)
				} catch (error) {
					getLogger().warn(
						`Failed to install dependencies in child worktree ${child.number}: ${error instanceof Error ? error.message : 'Unknown error'}`,
					)
				}

				results.push({
					issueId: rawId,
					worktreePath: childWorktreePath,
					branch: childBranch,
					success: true,
				})

				getLogger().success(`Created child worktree for ${child.number}`)
			} catch (error) {
				const rawId = child.number.replace(/^#/, '')
				const errorMessage = error instanceof Error ? error.message : 'Unknown error'
				getLogger().warn(`Failed to create child worktree for ${child.number}: ${errorMessage}`)
				results.push({
					issueId: rawId,
					worktreePath: '',
					branch: '',
					success: false,
					error: errorMessage,
				})
			}
		}

		return results
	}

	/**
	 * Render swarm-mode agent templates to the epic worktree's .claude/agents/ directory.
	 */
	async renderSwarmAgents(epicWorktreePath: string): Promise<string[]> {
		const claudeAgentsDir = path.join(epicWorktreePath, '.claude', 'agents')
		await fs.ensureDir(claudeAgentsDir)

		const settings = await this.settingsManager.loadSettings()

		const templateVariables: TemplateVariables = {
			SWARM_MODE: true,
		}

		const agents = await this.agentManager.loadAgents(settings, templateVariables)

		const renderedFiles: string[] = []

		for (const [agentName, agentConfig] of Object.entries(agents)) {
			const swarmFileName = agentName.startsWith('iloom-')
				? `iloom-swarm-${agentName.slice('iloom-'.length)}.md`
				: `iloom-swarm-${agentName}.md`

			const outputPath = path.join(claudeAgentsDir, swarmFileName)

			const toolsLine = agentConfig.tools ? `tools: ${agentConfig.tools.join(', ')}` : ''
			const colorLine = agentConfig.color ? `color: ${agentConfig.color}` : ''

			const frontmatterLines = [
				'---',
				`name: ${swarmFileName.replace('.md', '')}`,
				`description: ${agentConfig.description}`,
				...(toolsLine ? [toolsLine] : []),
				...(colorLine ? [colorLine] : []),
				`model: ${agentConfig.model}`,
				'---',
			]

			const content = `${frontmatterLines.join('\n')}\n\n${agentConfig.prompt}\n`

			await fs.writeFile(outputPath, content, 'utf-8')
			renderedFiles.push(swarmFileName)
			getLogger().debug(`Rendered swarm agent: ${swarmFileName}`)
		}

		getLogger().success(`Rendered ${renderedFiles.length} swarm agents to ${claudeAgentsDir}`)
		return renderedFiles
	}

	/**
	 * Render the swarm workflow skill to the epic worktree's .claude/skills/ directory.
	 */
	async renderSwarmSkill(epicWorktreePath: string): Promise<boolean> {
		const skillDir = path.join(epicWorktreePath, '.claude', 'skills', 'iloom-swarm-workflow')
		const skillOutputPath = path.join(skillDir, 'SKILL.md')

		await fs.ensureDir(skillDir)

		const skillTemplatePath = this.findSkillTemplate()

		if (!skillTemplatePath) {
			getLogger().warn('Could not find swarm workflow skill template')
			return false
		}

		try {
			const skillContent = await fs.readFile(skillTemplatePath, 'utf-8')
			await fs.writeFile(skillOutputPath, skillContent, 'utf-8')
			getLogger().success(`Rendered swarm skill to ${skillOutputPath}`)
			return true
		} catch (error) {
			getLogger().warn(
				`Failed to render swarm skill: ${error instanceof Error ? error.message : 'Unknown error'}`,
			)
			return false
		}
	}

	/**
	 * Find the swarm workflow skill template by walking up from the package directory.
	 */
	private findSkillTemplate(): string | null {
		const currentFilePath = fileURLToPath(import.meta.url)
		let currentDir = path.dirname(currentFilePath)

		while (currentDir !== path.dirname(currentDir)) {
			const candidatePath = path.join(
				currentDir,
				'templates',
				'skills',
				'iloom-swarm-workflow',
				'SKILL.md',
			)
			try {
				fs.accessSync(candidatePath)
				return candidatePath
			} catch {
				currentDir = path.dirname(currentDir)
			}
		}

		return null
	}

	/**
	 * Run the full swarm setup: child worktrees, agents, and skill.
	 *
	 * The epic worktree already exists (created by `il start`).
	 */
	async setupSwarm(
		epicIssueNumber: string | number,
		epicBranch: string,
		epicWorktreePath: string,
		childIssues: SwarmChildIssue[],
		mainWorktreePath: string,
		issueTrackerName: string,
	): Promise<SwarmSetupResult> {
		// 1. Create child worktrees
		const childWorktrees = await this.createChildWorktrees(
			childIssues,
			epicBranch,
			epicWorktreePath,
			mainWorktreePath,
			epicIssueNumber,
			issueTrackerName,
		)

		// 2. Render swarm agents to epic worktree's .claude/ directory
		const agentsRendered = await this.renderSwarmAgents(epicWorktreePath)

		// 3. Render swarm skill to epic worktree's .claude/ directory
		const skillRendered = await this.renderSwarmSkill(epicWorktreePath)

		const successCount = childWorktrees.filter((c) => c.success).length
		const failCount = childWorktrees.filter((c) => !c.success).length

		getLogger().success(
			`Swarm setup complete: ${successCount} child worktrees` +
				(failCount > 0 ? ` (${failCount} failed)` : ''),
		)

		return {
			epicWorktreePath,
			epicBranch,
			childWorktrees,
			agentsRendered,
			skillRendered,
		}
	}
}
