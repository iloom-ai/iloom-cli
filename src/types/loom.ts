export type ProjectCapability = 'cli' | 'web'
export type Capability = ProjectCapability

export interface Loom {
  id: string
  path: string
  branch: string
  type: 'issue' | 'pr' | 'branch'
  identifier: string | number
  port: number
  databaseBranch?: string
  createdAt: Date
  lastAccessed: Date
  issueData?: {
    title?: string
    body?: string
    url?: string
    state?: string
  }
  capabilities?: ProjectCapability[]
  binEntries?: Record<string, string>
  cliSymlinks?: string[]
}

export interface CreateLoomInput {
  type: 'issue' | 'pr' | 'branch'
  identifier: string | number
  originalInput: string
  baseBranch?: string
  parentLoom?: {
    type: 'issue' | 'pr' | 'branch'
    identifier: string | number
    branchName: string
    worktreePath: string
    databaseBranch?: string
  }
  options?: {
    skipDatabase?: boolean
    skipColorSync?: boolean
    // Individual component flags
    enableClaude?: boolean
    enableCode?: boolean
    enableDevServer?: boolean
    enableTerminal?: boolean
    // One-shot automation mode
    oneShot?: import('./index.js').OneShotMode
    // Raw --set arguments to forward to spin
    setArguments?: string[]
    // Executable path to use for spin command (e.g., 'il', 'il-125', or '/path/to/dist/cli.js')
    executablePath?: string
    // Control .env sourcing in terminal launches
    sourceEnvOnStart?: boolean
  }
}

export type LaunchMode = 'editor' | 'terminal' | 'both'

export interface LoomSummary {
  id: string
  type: 'issue' | 'pr' | 'branch'
  identifier: string | number
  title?: string
  branch: string
  port: number
  status: 'active' | 'stale' | 'error'
  lastAccessed: string
}
