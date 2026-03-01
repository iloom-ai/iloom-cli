export type ProjectCapability = 'cli' | 'web'
export type Capability = ProjectCapability

export interface Loom {
  id: string
  path: string
  branch: string
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  port: number
  databaseBranch?: string
  description?: string
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
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  originalInput: string
  baseBranch?: string
  parentLoom?: {
    type: 'issue' | 'pr' | 'branch' | 'epic'
    identifier: string | number
    branchName: string
    worktreePath: string
    databaseBranch?: string
  }
  options?: {
    skipDatabase?: boolean
    // Color sync options (derived from settings, can be overridden)
    colorTerminal?: boolean
    colorVscode?: boolean
    // Individual component flags
    enableClaude?: boolean
    enableCode?: boolean
    enableDevServer?: boolean
    enableTerminal?: boolean
    // One-shot automation mode
    oneShot?: import('./index.js').OneShotMode
    // Complexity override (skips complexity evaluation)
    complexity?: import('./index.js').ComplexityOverride
    // Raw --set arguments to forward to spin
    setArguments?: string[]
    // Executable path to use for spin command (e.g., 'il', 'il-125', or '/path/to/dist/cli.js')
    executablePath?: string
    // Control .env sourcing in terminal launches
    sourceEnvOnStart?: boolean
    // Child issue numbers for epic looms
    childIssueNumbers?: string[]
    // Rich child issue data for epic looms (number with prefix, title, body, url)
    childIssues?: Array<{
      number: string
      title: string
      body: string
      url: string
    }>
    // Dependency map for epic looms (issueNumber -> array of blocking issueNumbers)
    dependencyMap?: Record<string, string[]>
  }
}

export type LaunchMode = 'editor' | 'terminal' | 'both'

export interface LoomSummary {
  id: string
  type: 'issue' | 'pr' | 'branch' | 'epic'
  identifier: string | number
  title?: string
  branch: string
  port: number
  status: 'active' | 'stale' | 'error'
  lastAccessed: string
}
