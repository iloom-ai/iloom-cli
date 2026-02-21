import fs from 'fs-extra'
import path from 'path'
import fg from 'fast-glob'

/**
 * Detect the primary programming language of a project by checking for common project files.
 * Checks are performed in priority order; the first match wins.
 * All errors are caught and return 'unknown' — this function is non-blocking.
 */
export async function detectProjectLanguage(projectPath: string): Promise<string> {
  try {
    // 1. package.json → check for 'typescript' in deps/devDeps → 'typescript' or 'javascript'
    const packageJsonPath = path.join(projectPath, 'package.json')
    if (await fs.pathExists(packageJsonPath)) {
      try {
        const pkg = await fs.readJson(packageJsonPath) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
        return 'typescript' in allDeps ? 'typescript' : 'javascript'
      } catch {
        return 'javascript'
      }
    }

    // 2. Cargo.toml → 'rust'
    if (await fs.pathExists(path.join(projectPath, 'Cargo.toml'))) {
      return 'rust'
    }

    // 3. go.mod → 'go'
    if (await fs.pathExists(path.join(projectPath, 'go.mod'))) {
      return 'go'
    }

    // 4. pyproject.toml | setup.py | requirements.txt → 'python'
    for (const file of ['pyproject.toml', 'setup.py', 'requirements.txt']) {
      if (await fs.pathExists(path.join(projectPath, file))) {
        return 'python'
      }
    }

    // 5. Gemfile → 'ruby'
    if (await fs.pathExists(path.join(projectPath, 'Gemfile'))) {
      return 'ruby'
    }

    // 6. pom.xml | build.gradle | build.gradle.kts → 'java'
    for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      if (await fs.pathExists(path.join(projectPath, file))) {
        return 'java'
      }
    }

    // 7. *.csproj via glob → 'csharp'
    const csprojFiles = await fg('*.csproj', { cwd: projectPath, dot: false })
    if (csprojFiles.length > 0) {
      return 'csharp'
    }

    // 8. Default
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
