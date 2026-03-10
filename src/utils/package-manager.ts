import { execa, type ExecaError } from 'execa'
import { getLogger } from './logger-context.js'
import { getPackageScripts } from './package-json.js'
import { restoreTerminalState } from './terminal.js'
import fs from 'fs-extra'
import path from 'path'

export type PackageManager = 'pnpm' | 'npm' | 'yarn'

/**
 * Validate if a string is a supported package manager
 */
function isValidPackageManager(manager: string): manager is PackageManager {
  return manager === 'pnpm' || manager === 'npm' || manager === 'yarn'
}

/**
 * Detect which package manager to use for a project
 * Checks in order:
 * 1. packageManager field in package.json (Node.js standard)
 * 2. Lock files (pnpm-lock.yaml, package-lock.json, yarn.lock)
 * 3. Installed package managers (system-wide check)
 * 4. Defaults to npm if all detection fails
 *
 * @param cwd Working directory to detect package manager in (defaults to process.cwd())
 * @returns The detected package manager, or 'npm' as default
 */
export async function detectPackageManager(cwd: string = process.cwd()): Promise<PackageManager> {
  // 1. Check packageManager field in package.json
  try {
    const packageJsonPath = path.join(cwd, 'package.json')
    if (await fs.pathExists(packageJsonPath)) {
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent)

      if (packageJson.packageManager) {
        // Parse "pnpm@8.15.0" or "pnpm@10.16.1+sha512..." -> "pnpm"
        const manager = packageJson.packageManager.split('@')[0]
        if (isValidPackageManager(manager)) {
          getLogger().debug(`Detected package manager from package.json: ${manager}`)
          return manager
        }
      }
    }
  } catch (error) {
    // If package.json doesn't exist, is malformed, or unreadable, continue to next detection method
    getLogger().debug(`Could not read packageManager from package.json: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }

  // 2. Check lock files (priority: pnpm > npm > yarn)
  const lockFiles: Array<{ file: string; manager: PackageManager }> = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'package-lock.json', manager: 'npm' },
    { file: 'yarn.lock', manager: 'yarn' },
  ]

  for (const { file, manager } of lockFiles) {
    if (await fs.pathExists(path.join(cwd, file))) {
      getLogger().debug(`Detected package manager from lock file ${file}: ${manager}`)
      return manager
    }
  }

  // 3. Check installed package managers (original behavior)
  const managers: PackageManager[] = ['pnpm', 'npm', 'yarn']
  for (const manager of managers) {
    try {
      await execa(manager, ['--version'])
      getLogger().debug(`Detected installed package manager: ${manager}`)
      return manager
    } catch {
      // Continue to next manager
    }
  }

  // 4. Default to npm (always available in Node.js environments)
  getLogger().debug('No package manager detected, defaulting to npm')
  return 'npm'
}

/**
 * Install dependencies using the detected package manager
 * @param cwd Working directory to run install in
 * @param frozen Whether to use frozen lockfile (for production installs)
 * @param quiet Whether to suppress command output (default: false)
 * @returns true if installation succeeded, throws Error on failure
 */
export async function installDependencies(
  cwd: string,
  frozen: boolean = true,
  quiet: boolean = false
): Promise<void> {
  // Check if working directory is provided
  if (!cwd) {
    getLogger().debug('Skipping dependency installation - no working directory provided')
    return
  }

  // Check for install script in package.iloom.json or package.json
  const scripts = await getPackageScripts(cwd)
  if (scripts.install) {
    getLogger().info('Installing dependencies with install script...')
    // runScript handles both iloom-config (shell execution) and package-manager (npm/pnpm/yarn) sources
    await runScript('install', cwd, [], { quiet })
    getLogger().success('Dependencies installed successfully')
    return
  }

  // Fall back to Node.js package manager detection for projects without install script
  const pkgPath = path.join(cwd, 'package.json')
  if (!(await fs.pathExists(pkgPath))) {
    getLogger().debug('Skipping dependency installation - no package.json found and no install script')
    return
  }

  const packageManager = await detectPackageManager(cwd)

  getLogger().info(`Installing dependencies with ${packageManager}...`)

  const args: string[] = ['install']

  // Add frozen lockfile flag based on package manager
  if (frozen) {
    switch (packageManager) {
      case 'pnpm':
        args.push('--frozen-lockfile')
        break
      case 'yarn':
        args.push('--frozen-lockfile')
        break
      case 'npm':
        args.shift()  // Remove 'install'
        args.push('ci')  // npm ci is equivalent to frozen lockfile
        break
    }
  }

  try {
    await execa(packageManager, args, {
      cwd,
      stdio: quiet ? 'pipe' : 'inherit',
      timeout: 300000,   // 5 minute timeout for install
    })

    getLogger().success('Dependencies installed successfully')
  } catch (error) {
    const execaError = error as ExecaError
    const stderr = execaError.stderr ?? execaError.message ?? 'Unknown error'
    throw new Error(`Failed to install dependencies: ${stderr}`)
  }
}

/**
 * Options for running a script
 */
export interface RunScriptOptions {
  /** Suppress command output (default: false) */
  quiet?: boolean
  /** Custom environment variables merged with process.env */
  env?: Record<string, string>
  /** Use inherited stdio, return process info (default: false) */
  foreground?: boolean
  /** Callback when process starts, receives PID */
  onStart?: (pid?: number) => void
  /** Don't set CI=true (for dev servers, default: false) */
  noCi?: boolean
}

/**
 * Run a package.json or iloom config script
 * Automatically detects whether to use package manager or direct shell execution
 * based on the script source.
 *
 * @param scriptName The script name from package.json or package.iloom.json
 * @param cwd Working directory
 * @param args Additional arguments to pass to the script
 * @param options Execution options
 * @returns Object with pid when foreground mode is enabled
 */
export async function runScript(
  scriptName: string,
  cwd: string,
  args: string[] = [],
  options: RunScriptOptions = {}
): Promise<{ pid?: number }> {
  // Get scripts with source metadata
  const scripts = await getPackageScripts(cwd)
  const scriptConfig = scripts[scriptName]

  const isDebugMode = getLogger().isDebugEnabled()

  if (!scriptConfig) {
    throw new Error(`Script '${scriptName}' not found`)
  }

  // Build environment variables
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...options.env,
  }

  // Add CI=true unless noCi is set
  if (!options.noCi) {
    env.CI = 'true'
  }

  // Determine stdio mode
  const stdio = options.foreground ? 'inherit' : (options.quiet ? 'pipe' : 'inherit')

  // For foreground mode, register a no-op SIGINT handler to prevent signal-exit
  // (used internally by execa) from re-raising SIGINT and killing the process
  // before finally blocks can run. This ensures terminal state is restored on Ctrl+C.
  const onSigint = (): void => {}
  if (options.foreground) {
    process.on('SIGINT', onSigint)
  }

  try {
    let execaProcess

    if (scriptConfig.source === 'iloom-config') {
      // Execute directly as shell command (for non-Node.js projects)
      // Use "$@" pattern to properly handle argument escaping via the shell
      getLogger().debug(`Executing shell command: ${scriptConfig.command} with args: ${args.join(' ')}`)

      execaProcess = execa('sh', ['-c', `${scriptConfig.command} "$@"`, '--', ...args], {
        cwd,
        stdio,
        ...(!options.foreground && { timeout: 600000 }), // No timeout for foreground mode
        env,
        verbose: isDebugMode,
      })
    } else {
      // Execute via package manager (for Node.js projects)
      const packageManager = await detectPackageManager(cwd)
      const command = packageManager === 'npm' ? ['run', scriptName] : [scriptName]

      execaProcess = execa(packageManager, [...command, ...args], {
        cwd,
        stdio,
        ...(!options.foreground && { timeout: 600000 }), // No timeout for foreground mode
        env,
        verbose: isDebugMode,
      })
    }

    // For foreground mode, get PID and call onStart callback immediately
    const result: { pid?: number } = {}
    if (options.foreground && execaProcess.pid !== undefined) {
      result.pid = execaProcess.pid
    }

    // Call onStart callback if provided
    if (options.onStart) {
      options.onStart(result.pid)
    }

    // Wait for process to complete
    await execaProcess

    return result
  } catch (error) {
    const execaError = error as ExecaError
    // If the process was killed by SIGINT, the user intentionally cancelled — return silently
    if (options.foreground && execaError.signal === 'SIGINT') {
      return {}
    }
    const stderr = execaError.stderr ?? execaError.message ?? 'Unknown error'
    throw new Error(`Failed to run script '${scriptName}': ${stderr}`)
  } finally {
    if (options.foreground) {
      process.removeListener('SIGINT', onSigint)
      restoreTerminalState()
    }
  }
}
