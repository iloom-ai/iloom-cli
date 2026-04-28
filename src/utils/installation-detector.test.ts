import { describe, it, expect, beforeEach, vi } from 'vitest'
import { detectInstallationMethod, isVoltaInstall, shouldShowUpdateNotification } from './installation-detector.js'
import fs from 'fs'
import type { Stats } from 'fs'

// Mock fs module
vi.mock('fs')

describe('detectInstallationMethod', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Set default mock for realpathSync to return the input path unchanged
    // (i.e., not a symlink by default)
    vi.mocked(fs.realpathSync).mockImplementation((path: string | Buffer) => path as string)
  })

  it('returns "linked" when the script is a symlink pointing outside node_modules', () => {
    // Mock lstatSync to return isSymbolicLink: true
    const mockStats = {
      isSymbolicLink: () => true,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)

    // Mock realpathSync to return a path outside node_modules (local development)
    vi.mocked(fs.realpathSync).mockReturnValue('/Users/dev/iloom-cli/dist/cli.js')

    const result = detectInstallationMethod('/usr/local/bin/il')
    expect(result).toBe('linked')
  })

  it('returns "global" when symlink points to node_modules (npm global install via NVM)', () => {
    // Mock lstatSync to return isSymbolicLink: true
    const mockStats = {
      isSymbolicLink: () => true,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)

    // Mock realpathSync to return a path in node_modules
    vi.mocked(fs.realpathSync).mockReturnValue(
      '/Users/user/.nvm/versions/node/v22.17.0/lib/node_modules/@iloom/cli/dist/cli.js'
    )

    // Mock existsSync to return false (not source directory)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/Users/user/.nvm/versions/node/v22.17.0/bin/il')
    expect(result).toBe('global')
  })

  it('returns "local" when running from source directory (has src/ sibling)', () => {
    // Mock lstatSync to return isSymbolicLink: false
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)

    // Mock existsSync for src/ and package.json
    vi.mocked(fs.existsSync).mockImplementation((path: string | Buffer) => {
      const pathStr = path.toString()
      return pathStr.includes('/src') || pathStr.includes('package.json')
    })

    const result = detectInstallationMethod('/Users/dev/iloom/dist/cli.js')
    expect(result).toBe('local')
  })

  it('returns "global" when running from global node_modules', () => {
    // Mock lstatSync to return isSymbolicLink: false
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)

    // Mock existsSync to return false (not source directory)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/usr/local/lib/node_modules/iloom-cli/dist/cli.js')
    expect(result).toBe('global')
  })

  it('returns "global" for NVM installations', () => {
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/Users/user/.nvm/versions/node/v18.0.0/lib/node_modules/iloom-cli/dist/cli.js')
    expect(result).toBe('global')
  })

  it('returns "global" for Homebrew installations on Apple Silicon', () => {
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/opt/homebrew/lib/node_modules/iloom-cli/dist/cli.js')
    expect(result).toBe('global')
  })

  it('returns "global" for Windows global installations', () => {
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\iloom-cli\\dist\\cli.js')
    expect(result).toBe('global')
  })

  it('returns "unknown" when cannot determine installation method', () => {
    // Mock lstatSync to return isSymbolicLink: false
    const mockStats = {
      isSymbolicLink: () => false,
    } as unknown as Stats
    vi.mocked(fs.lstatSync).mockReturnValue(mockStats)

    // Mock existsSync to return false (not source directory)
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/some/random/path/dist/cli.js')
    expect(result).toBe('unknown')
  })

  it('handles errors gracefully and returns "unknown"', () => {
    // Mock lstatSync to throw an error
    vi.mocked(fs.lstatSync).mockImplementation((): Stats => {
      throw new Error('ENOENT')
    })

    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = detectInstallationMethod('/path/to/script')
    expect(result).toBe('unknown')
  })
})

describe('isVoltaInstall', () => {
  beforeEach(() => {
    vi.mocked(fs.realpathSync).mockImplementation((path: string | Buffer) => path as string)
  })

  it('returns true for paths under ~/.volta/', () => {
    expect(
      isVoltaInstall('/Users/user/.volta/tools/image/packages/@iloom/cli/lib/node_modules/@iloom/cli/dist/cli.js')
    ).toBe(true)
  })

  it('returns true when a symlink resolves into ~/.volta/', () => {
    vi.mocked(fs.realpathSync).mockReturnValue(
      '/Users/user/.volta/tools/image/packages/@iloom/cli/lib/node_modules/@iloom/cli/dist/cli.js'
    )
    expect(isVoltaInstall('/Users/user/.volta/bin/il')).toBe(true)
  })

  it('returns false for non-Volta global installs', () => {
    expect(
      isVoltaInstall('/Users/user/.nvm/versions/node/v22.17.0/lib/node_modules/@iloom/cli/dist/cli.js')
    ).toBe(false)
  })

  it('returns false when realpathSync throws and the original path is not Volta', () => {
    vi.mocked(fs.realpathSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(isVoltaInstall('/usr/local/lib/node_modules/@iloom/cli/dist/cli.js')).toBe(false)
  })
})

describe('shouldShowUpdateNotification', () => {
  it('returns true for global installations', () => {
    expect(shouldShowUpdateNotification('global')).toBe(true)
  })

  it('returns false for local installations', () => {
    expect(shouldShowUpdateNotification('local')).toBe(false)
  })

  it('returns false for linked installations', () => {
    expect(shouldShowUpdateNotification('linked')).toBe(false)
  })

  it('returns false for unknown installations', () => {
    expect(shouldShowUpdateNotification('unknown')).toBe(false)
  })
})
