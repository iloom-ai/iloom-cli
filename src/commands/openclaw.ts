import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import fs from 'fs-extra'
import { getLogger } from '../utils/logger-context.js'
import { TelemetryService } from '../lib/TelemetryService.js'

export interface OpenclawOptions {
  force?: boolean
  workspace?: string
}

export interface OpenclawResult {
  status: string
  source: string
  target: string
}

export class OpenclawCommand {
  private readonly projectRoot: string

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd()
  }

  async execute(options: OpenclawOptions = {}): Promise<OpenclawResult> {
    const logger = getLogger()
    const workspace = options.workspace ?? 'workspace'
    const force = options.force ?? false

    // 1. Resolve and verify openclaw-skill/ exists
    const skillSourceDir = await this.resolveSkillDir()
    logger.debug(`Resolved openclaw-skill directory: ${skillSourceDir}`)

    // 2. Check ~/.openclaw exists
    const openclawHome = path.join(os.homedir(), '.openclaw')
    if (!(await fs.pathExists(openclawHome))) {
      throw new Error('OpenClaw is not installed (~/.openclaw not found)')
    }

    // 3. Check workspace exists
    const workspaceDir = path.join(openclawHome, workspace)
    if (!(await fs.pathExists(workspaceDir))) {
      throw new Error(
        `Workspace '${workspace}' not found. Use --workspace <name> to specify a different workspace.`
      )
    }

    // 4. Ensure skills/ dir exists
    const skillsDir = path.join(workspaceDir, 'skills')
    await fs.mkdirp(skillsDir)

    // 5. Check existing target
    const targetPath = path.join(skillsDir, 'iloom')
    const wasAlreadyLinked = await this.handleExistingTarget(targetPath, skillSourceDir, force, workspace)

    if (wasAlreadyLinked) {
      this.trackLinked({ force, wasAlreadyLinked: true, customWorkspace: workspace !== 'workspace' })
      return {
        status: 'Already linked',
        source: skillSourceDir,
        target: targetPath,
      }
    }

    // 6. Create symlink
    await fs.symlink(skillSourceDir, targetPath)
    logger.debug(`Created symlink: ${targetPath} -> ${skillSourceDir}`)

    this.trackLinked({ force, wasAlreadyLinked: false, customWorkspace: workspace !== 'workspace' })

    return {
      status: 'Linked successfully',
      source: skillSourceDir,
      target: targetPath,
    }
  }

  /**
   * Resolve the openclaw-skill directory.
   * 1. Check relative to the package install location (dist/openclaw-skill/ for npm installs)
   * 2. Fall back to projectRoot/openclaw-skill/ (for local dev / repo clones)
   * 3. Throw if neither exists
   */
  private async resolveSkillDir(): Promise<string> {
    // 1. Relative to the installed package (works for npm installs)
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    // In dist: dist/commands/openclaw.js -> walk up to dist/, then openclaw-skill/
    let packageDir = __dirname
    while (packageDir !== path.dirname(packageDir)) {
      const candidate = path.join(packageDir, 'openclaw-skill')
      if (await fs.pathExists(candidate)) {
        return candidate
      }
      packageDir = path.dirname(packageDir)
    }

    // 2. Relative to projectRoot (for local dev / repo clones)
    const devCandidate = path.join(this.projectRoot, 'openclaw-skill')
    if (await fs.pathExists(devCandidate)) {
      return devCandidate
    }

    throw new Error(
      `openclaw-skill/ directory not found. Searched from package location (${__dirname}) and project root (${this.projectRoot}).`
    )
  }

  /**
   * Handle an existing file/symlink at the target path.
   * Returns true if already correctly linked (no action needed).
   * Throws if conflict exists and --force not specified.
   * Removes existing target if --force specified.
   */
  private async handleExistingTarget(
    targetPath: string,
    expectedSource: string,
    force: boolean,
    workspace: string
  ): Promise<boolean> {
    if (!(await fs.pathExists(targetPath)) && !(await this.isDeadSymlink(targetPath))) {
      return false
    }

    const isSymlink = await this.isSymlink(targetPath)

    if (isSymlink) {
      const currentTarget = await fs.readlink(targetPath)
      const resolvedCurrent = path.resolve(path.dirname(targetPath), currentTarget)
      const resolvedExpected = path.resolve(expectedSource)

      if (resolvedCurrent === resolvedExpected) {
        return true // Already correctly linked
      }
    }

    // Conflict exists
    if (!force) {
      const workspaceHint = workspace === 'workspace'
        ? ' Use --workspace <name> if you meant to install to a different workspace.'
        : ''
      const typeDesc = isSymlink ? 'a symlink pointing elsewhere' : 'a file or directory'
      throw new Error(
        `${targetPath} already exists as ${typeDesc}. Use --force to overwrite.${workspaceHint}`
      )
    }

    // Force: remove existing
    await fs.remove(targetPath)
    return false
  }

  private async isSymlink(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(filePath)
      return stats.isSymbolicLink()
    } catch {
      return false
    }
  }

  private async isDeadSymlink(filePath: string): Promise<boolean> {
    try {
      await fs.lstat(filePath) // lstat succeeds even for dead symlinks
      const exists = await fs.pathExists(filePath) // pathExists follows the link
      return !exists
    } catch {
      return false
    }
  }

  private trackLinked(props: { force: boolean; wasAlreadyLinked: boolean; customWorkspace: boolean }): void {
    try {
      TelemetryService.getInstance().track('openclaw.linked', {
        force: props.force,
        was_already_linked: props.wasAlreadyLinked,
        custom_workspace: props.customWorkspace,
      })
    } catch (error) {
      const logger = getLogger()
      logger.debug(`Telemetry error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
