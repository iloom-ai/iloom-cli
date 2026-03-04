import path from 'path'
import os from 'os'
import crypto from 'crypto'
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
 * Writes the prompt to a temp directory with a unique filename derived
 * from the workspace path, and returns the file path for use with
 * `--append-system-prompt-file`.
 *
 * The file is written to os.tmpdir() instead of inside the workspace
 * to avoid polluting the repo with untracked files.
 */
export async function prepareSystemPromptForPlatform(
	systemPrompt: string,
	workspacePath: string,
): Promise<SystemPromptConfig> {
	const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12)
	const promptFilePath = path.join(os.tmpdir(), `iloom-system-prompt-${hash}.md`)

	await fs.writeFile(promptFilePath, systemPrompt, 'utf-8')

	return { appendSystemPromptFile: promptFilePath }
}
