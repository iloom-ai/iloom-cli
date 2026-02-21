import { describe, it, expect, vi } from 'vitest'
import fs from 'fs-extra'
import fg from 'fast-glob'
import { detectProjectLanguage } from './language-detector.js'

vi.mock('fs-extra')
vi.mock('fast-glob')

function mockPathExists(existingFiles: string[]) {
  vi.mocked(fs.pathExists).mockImplementation(((filePath: string) =>
    Promise.resolve(existingFiles.some((f) => filePath.endsWith(f)))) as typeof fs.pathExists)
}

describe('detectProjectLanguage', () => {
  it('detects typescript when package.json has typescript in dependencies', async () => {
    mockPathExists(['package.json'])
    vi.mocked(fs.readJson).mockResolvedValueOnce({
      dependencies: { typescript: '^5.0.0' },
    })

    expect(await detectProjectLanguage('/project')).toBe('typescript')
  })

  it('detects typescript when package.json has typescript in devDependencies', async () => {
    mockPathExists(['package.json'])
    vi.mocked(fs.readJson).mockResolvedValueOnce({
      devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
    })

    expect(await detectProjectLanguage('/project')).toBe('typescript')
  })

  it('detects javascript when package.json has no typescript dep', async () => {
    mockPathExists(['package.json'])
    vi.mocked(fs.readJson).mockResolvedValueOnce({
      dependencies: { express: '^4.18.0' },
    })

    expect(await detectProjectLanguage('/project')).toBe('javascript')
  })

  it('detects javascript when package.json has empty deps', async () => {
    mockPathExists(['package.json'])
    vi.mocked(fs.readJson).mockResolvedValueOnce({})

    expect(await detectProjectLanguage('/project')).toBe('javascript')
  })

  it('detects javascript when package.json is malformed', async () => {
    mockPathExists(['package.json'])
    vi.mocked(fs.readJson).mockRejectedValueOnce(new Error('Invalid JSON'))

    expect(await detectProjectLanguage('/project')).toBe('javascript')
  })

  it('detects rust from Cargo.toml', async () => {
    mockPathExists(['Cargo.toml'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('rust')
  })

  it('detects go from go.mod', async () => {
    mockPathExists(['go.mod'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('go')
  })

  it('detects python from pyproject.toml', async () => {
    mockPathExists(['pyproject.toml'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('python')
  })

  it('detects python from setup.py', async () => {
    mockPathExists(['setup.py'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('python')
  })

  it('detects python from requirements.txt', async () => {
    mockPathExists(['requirements.txt'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('python')
  })

  it('detects ruby from Gemfile', async () => {
    mockPathExists(['Gemfile'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('ruby')
  })

  it('detects java from pom.xml', async () => {
    mockPathExists(['pom.xml'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('java')
  })

  it('detects java from build.gradle', async () => {
    mockPathExists(['build.gradle'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('java')
  })

  it('detects java from build.gradle.kts', async () => {
    mockPathExists(['build.gradle.kts'])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('java')
  })

  it('detects csharp from *.csproj files', async () => {
    mockPathExists([])
    vi.mocked(fg).mockResolvedValue(['MyApp.csproj'])

    expect(await detectProjectLanguage('/project')).toBe('csharp')
  })

  it('returns unknown when no project files are found', async () => {
    mockPathExists([])
    vi.mocked(fg).mockResolvedValue([])

    expect(await detectProjectLanguage('/project')).toBe('unknown')
  })

  it('returns first matching language in priority order', async () => {
    // Both package.json and Cargo.toml exist — package.json wins
    mockPathExists(['package.json', 'Cargo.toml'])
    vi.mocked(fs.readJson).mockResolvedValueOnce({
      dependencies: { typescript: '^5.0.0' },
    })

    expect(await detectProjectLanguage('/project')).toBe('typescript')
  })

  it('handles fs errors gracefully and returns unknown', async () => {
    vi.mocked(fs.pathExists).mockRejectedValue(new Error('Permission denied'))

    expect(await detectProjectLanguage('/project')).toBe('unknown')
  })
})
