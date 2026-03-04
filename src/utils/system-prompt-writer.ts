import path from 'path'
import fs from 'fs-extra'

/**
 * Result of preparing the system prompt.
 * Always uses file-based delivery via --append-system-prompt-file.
 */
export interface SystemPromptConfig {
	/** Path to the file containing the system prompt */
	appendSystemPromptFile: string
}

/**
 * Prepare the system prompt by writing it to a file.
 *
 * Writes the prompt to `workspacePath/.claude/iloom-system-prompt.md`
 * and returns the file path for use with `--append-system-prompt-file`.
 *
 * This works on all platforms now that Claude CLI supports
 * `--append-system-prompt-file` in interactive mode.
 */
export async function prepareSystemPromptForPlatform(
	systemPrompt: string,
	workspacePath: string,
): Promise<SystemPromptConfig> {
	const claudeDir = path.join(workspacePath, '.claude')
	const promptFilePath = path.join(claudeDir, 'iloom-system-prompt.md')

	await fs.ensureDir(claudeDir)
	await fs.writeFile(promptFilePath, systemPrompt, 'utf-8')

	return { appendSystemPromptFile: promptFilePath }
}
