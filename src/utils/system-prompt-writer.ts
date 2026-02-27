import path from 'path'
import fs from 'fs-extra'

/**
 * Result of preparing the system prompt for a specific platform.
 * Exactly one of these strategies will be populated.
 */
export interface SystemPromptConfig {
	/** Inline system prompt (macOS + Linux) */
	appendSystemPrompt?: string
	/** Plugin directory for --plugin-dir (Windows) */
	pluginDir?: string
	/** Override the initial user prompt (Windows: '/clear' to trigger SessionStart) */
	initialPromptOverride?: string
}

/**
 * Prepare the system prompt for the current platform.
 *
 * - darwin: inline via --append-system-prompt (unchanged)
 * - linux: inline via --append-system-prompt (80KB < 128KB limit)
 * - win32: write to file, create SessionStart plugin, pass /clear
 */
export async function prepareSystemPromptForPlatform(
	systemPrompt: string,
	workspacePath: string,
	platform: string = process.platform,
): Promise<SystemPromptConfig> {
	if (platform === 'darwin' || platform === 'linux') {
		// macOS and Linux: inline system prompt
		return { appendSystemPrompt: systemPrompt }
	}

	// Windows: write system prompt to file, create SessionStart hook plugin
	const claudeDir = path.join(workspacePath, '.claude')
	const promptFilePath = path.join(claudeDir, 'iloom-system-prompt.md')
	const pluginDir = path.join(claudeDir, 'iloom-plugin')

	await fs.ensureDir(claudeDir)
	await fs.writeFile(promptFilePath, systemPrompt, 'utf-8')

	// Create plugin directory with SessionStart hook
	await createSessionStartPlugin(pluginDir, promptFilePath)

	return {
		pluginDir,
		initialPromptOverride: '/clear',
	}
}

/**
 * Create a SessionStart hook plugin that injects the system prompt file content.
 *
 * Writes a small runner.js script that reads and outputs the prompt file,
 * since `cat` is not available natively on Windows and Node.js is guaranteed
 * to be present (Claude Code requires it).
 *
 * Uses a runner file instead of `node -e` to avoid command injection when
 * the workspace path contains quotes or special characters.
 */
export async function createSessionStartPlugin(
	pluginDir: string,
	promptFilePath: string,
): Promise<void> {
	await fs.ensureDir(pluginDir)

	// Write a small runner script that safely embeds the file path via JSON.stringify
	const runnerScript = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(promptFilePath)}, 'utf-8'));`
	await fs.writeFile(path.join(pluginDir, 'runner.js'), runnerScript, 'utf-8')

	// Use forward slashes in the hooks command for cross-platform portability
	const portableRunnerPath = path.join(pluginDir, 'runner.js').replace(/\\/g, '/')

	const hooksConfig = {
		hooks: {
			SessionStart: [
				{
					matcher: '*',
					hooks: [
						{
							type: 'command' as const,
							command: `node "${portableRunnerPath}"`,
						},
					],
				},
			],
		},
	}

	await fs.writeFile(
		path.join(pluginDir, 'hooks.json'),
		JSON.stringify(hooksConfig, null, 2),
		'utf-8',
	)
}
