# iloom Technical Architecture Documentation
## Authentication, Environment Management, and System Design

*Generated: November 9, 2025*

---

## Executive Summary

This document provides a comprehensive technical analysis of iloom's architecture, focusing on system design, authentication mechanisms, environment management, and process orchestration. The analysis is based on examining the complete codebase and documenting actual implementation patterns without assumptions about future use cases.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Core Workflows](#2-core-workflows)
3. [Authentication Architecture](#3-authentication-architecture)
4. [Environment and Secrets Management](#4-environment-and-secrets-management)
5. [Process Orchestration](#5-process-orchestration)
6. [Data Flow and State Management](#6-data-flow-and-state-management)
7. [External Dependencies](#7-external-dependencies)
8. [File System Architecture](#8-file-system-architecture)
9. [Security Model](#9-security-model)
10. [Configuration System](#10-configuration-system)

---

## 1. System Architecture

### 1.1 Component Hierarchy

```
Application Entry Point
├── CLI Interface (cli.ts - 840 lines)
│   └── Commander.js command registration
│
├── Command Layer (commands/)
│   ├── Core Commands (start, finish, cleanup)
│   ├── Utility Commands (ignite, open, run)
│   ├── Management Commands (add-issue, enhance, feedback)
│   └── Test Commands (7 test-* commands)
│
├── Business Logic Layer (lib/)
│   ├── Orchestrators
│   │   ├── LoomMananger - Workspace lifecycle
│   │   ├── AgentManager - AI agent orchestration
│   │   └── ProcessManager - Process lifecycle
│   │
│   ├── Service Providers
│   │   ├── GitHubService - GitHub API wrapper
│   │   ├── ClaudeService - Claude CLI wrapper
│   │   └── NeonProvider - Database branching
│   │
│   └── Managers
│       ├── GitWorktreeManager - Git operations
│       ├── EnvironmentManager - .env file handling
│       ├── SettingsManager - Configuration loading
│       ├── ValidationRunner - Test/lint/typecheck
│       └── MergeManager - Git merge operations
│
└── Utility Layer (utils/)
    ├── CLI Wrappers (git.ts, github.ts, claude.ts)
    ├── File Operations (env.ts, package-json.ts)
    └── System Integration (terminal.ts, vscode.ts, browser.ts)
```

### 1.2 Execution Flow Architecture

```typescript
// Primary execution pattern
CLI Command → Command Class → Service Layer → Utility Layer → External CLI

// Example: il start 25
StartCommand.execute()
  → GitHubService.fetchIssue(25)
    → executeGhCommand(['issue', 'view', '25'])
      → execa('gh', args, options)
```

### 1.3 Dependency Injection Pattern

All command classes use constructor injection with default fallbacks:

```typescript
export class StartCommand {
  constructor(
    private github?: GitHubService,
    private manager?: LoomMananger,
    private settings?: SettingsManager,
  ) {
    this.github ??= new GitHubService()
    this.manager ??= new LoomMananger()
    this.settings ??= new SettingsManager()
  }
}
```

---

## 2. Core Workflows

### 2.1 Workspace Creation Workflow (`il start`)

```
Input Processing
  ├── Parse identifier (issue/PR/branch/description)
  ├── Fetch GitHub data if applicable
  └── Check for existing worktree

Branch Generation
  ├── Use Claude API (Haiku model) for name generation
  └── Create standardized branch name

Workspace Setup
  ├── Create Git worktree
  ├── Copy and configure .env file
  ├── Install dependencies (pnpm/npm)
  ├── Setup database branch (if configured)
  └── Create CLI symlinks (if CLI project)

AI Agent Orchestration
  ├── Complexity Evaluator
  ├── Enhancement Agent (if needed)
  ├── Analysis Agent (complex issues)
  └── Planning Agent (complex issues)

Component Launch
  ├── VS Code (with color coding)
  ├── Development server
  └── Claude CLI with context
```

### 2.2 Workspace Completion Workflow (`il finish`)

```
Validation Phase
  ├── Detect current worktree
  ├── Check uncommitted changes
  ├── Run validation pipeline
  │   ├── Typecheck
  │   ├── Lint
  │   └── Tests
  └── Auto-fix with Claude (if enabled)

Integration Phase
  ├── Auto-commit changes
  ├── Rebase on main branch
  ├── Fast-forward merge
  └── Push to remote

Cleanup Phase
  ├── Terminate dev server
  ├── Remove database branch
  ├── Remove CLI symlinks
  ├── Delete Git worktree
  └── Update GitHub issue
```

### 2.3 AI Agent Pipeline

```typescript
// Agent execution flow
AgentManager.runAgent(agentName, context)
  → Load agent markdown from dist/agents/
  → Parse frontmatter for configuration
  → Select model from settings
  → Execute via Claude CLI
  → Post results to GitHub comments
```

---

## 3. Authentication Architecture

### 3.1 Authentication Delegation Model

The system delegates all authentication to external CLI tools:

```
iloom
  ├── GitHub Operations → GitHub CLI (`gh`)
  │   └── Credentials: ~/.config/gh/hosts.yml
  │
  ├── AI Operations → Claude CLI (`claude`)
  │   └── Credentials: Claude CLI internal storage
  │
  └── Database Operations → Neon CLI (`neon`)
      └── Credentials: Neon CLI internal storage
```

### 3.2 GitHub CLI Integration

**Authentication Check:**
```typescript
// src/utils/github.ts:61-74
export async function checkGhAuth(): Promise<{
  isAuthenticated: boolean
  hasProjectScope: boolean
}> {
  try {
    const result = await execa('gh', ['auth', 'status'])
    return {
      isAuthenticated: true,
      hasProjectScope: result.stdout.includes('project')
    }
  } catch {
    return { isAuthenticated: false, hasProjectScope: false }
  }
}
```

**Command Execution:**
```typescript
// src/utils/github.ts:18-31
async function executeGhCommand(args: string[], options?: {
  cwd?: string
  timeout?: number
}): Promise<ExecaReturnValue> {
  const result = await execa('gh', args, {
    cwd: options?.cwd ?? process.cwd(),
    timeout: options?.timeout ?? 30000,
    encoding: 'utf8',
  })
  return result
}
```

**Key Characteristics:**
- No token handling in application code
- All authentication via `gh auth login`
- Credentials stored in OS keychain via GitHub CLI
- Commands fail if not authenticated

### 3.3 Claude CLI Integration

**Execution Modes:**

```typescript
// src/utils/claude.ts:99-139
// Headless mode (programmatic)
if (headless) {
  const args = buildClaudeArgs(options)
  const result = await execa('claude', args, {
    input: prompt,
    timeout: 0,
    ...(addDir && { cwd: addDir }),
  })
  return result.stdout
}

// Interactive mode (user interaction)
else {
  const args = [...buildClaudeArgs(options), '--', prompt]
  await execa('claude', args, {
    stdio: 'inherit',
    ...(addDir && { cwd: addDir }),
  })
}
```

**Context Provision:**
```typescript
// Files accessible to Claude via --add-dir
--add-dir <worktree-path>  // Full workspace access
--add-file <specific-file>  // Specific file access
```

### 3.4 Neon CLI Integration

**Configuration Requirements:**
```typescript
// src/lib/providers/NeonProvider.ts:14-17
interface NeonConfig {
  projectId: string        // From settings.json: databaseProviders.neon.projectId
  parentBranch: string     // From settings.json: databaseProviders.neon.parentBranch
}
```

Neon configuration is managed through `.iloom/settings.json`:
```json
{
  "databaseProviders": {
    "neon": {
      "projectId": "your-project-id",
      "parentBranch": "main"
    }
  }
}
```

**Authentication Verification:**
```typescript
// src/lib/providers/NeonProvider.ts:52-63
async isAuthenticated(): Promise<boolean> {
  try {
    await this.executeNeonCommand(['me'])
    return true
  } catch (error) {
    logger.debug('Neon CLI not authenticated:', error)
    return false
  }
}
```

---

## 4. Environment and Secrets Management

### 4.1 Environment Variable Loading

**Loading Mechanism:**
```typescript
// src/utils/env.ts:135-194
export function loadEnvIntoProcess(options?: {
  path?: string
  nodeEnv?: string
  defaultNodeEnv?: string
}): { parsed?: Record<string, string>; error?: Error } {
  const configOptions: Partial<DotenvFlowConfigOptions> = {
    path: options?.path ?? process.cwd(),
    node_env: options?.nodeEnv ?? process.env.NODE_ENV,
    default_node_env: options?.defaultNodeEnv ?? 'development',
    silent: true, // Don't throw errors if .env files are missing
  }

  // Loads in order:
  // .env
  // .env.{NODE_ENV}
  // .env.local
  // .env.{NODE_ENV}.local
  const result = dotenvFlow.config(configOptions)
  return result
}
```

**Loading Points in Application:**
```typescript
// 1. Command initialization
// src/commands/start.ts:57
loadEnvIntoProcess()

// 2. LoomMananger initialization
// src/lib/LoomMananger.ts:14
loadEnvIntoProcess()

// 3. Main worktree environment loading
// src/lib/LoomMananger.ts:167-174
private loadMainEnvFile(): void {
  const mainEnvPath = path.join(this.paths.main, '.env')
  if (fs.existsSync(mainEnvPath)) {
    const envConfig = dotenv.parse(fs.readFileSync(mainEnvPath, 'utf-8'))
    for (const [key, value] of Object.entries(envConfig)) {
      process.env[key] = value
    }
  }
}
```

### 4.2 Environment Propagation to Child Processes

**Full Inheritance Pattern:**
```typescript
// src/commands/run.ts:247-251
await execa('node', [binFilePath, ...args], {
  stdio: 'inherit',
  cwd: worktreePath,
  env: process.env,  // Complete environment inheritance
})
```

**Process Environment Contains:**
- System environment variables (PATH, HOME, etc.)
- Application configuration (NODE_ENV, DEBUG)
- Service credentials (DATABASE_URL, API keys)
- iloom-specific (PORT, NEON_PROJECT_ID)

### 4.3 Workspace Environment Configuration

**Environment Setup Flow:**
```typescript
// src/lib/EnvironmentManager.ts
class EnvironmentManager {
  // 1. Copy main .env to workspace
  async copyMainEnvFile(source: string, destination: string): Promise<void> {
    await fs.copyFile(source, destination)
  }

  // 2. Modify environment variables
  async setEnvVar(envPath: string, key: string, value: string): Promise<void> {
    const env = await this.parseEnvFile(envPath)
    env[key] = value
    await this.writeEnvFile(envPath, env)
  }

  // 3. Set workspace-specific PORT
  async setupWebEnvironment(envPath: string, port: number): Promise<void> {
    await this.setEnvVar(envPath, 'PORT', String(port))
  }
}
```

**Port Assignment Strategy:**
```typescript
// src/utils/port.ts:7-14
export function calculatePort(issueOrPrNumber: number, basePort: number = 3000): number {
  if (issueOrPrNumber <= 0) {
    throw new Error('Issue or PR number must be positive')
  }
  return basePort + issueOrPrNumber
}
```

---

## 5. Process Orchestration

### 5.1 Process Execution Framework

**Core Execution Pattern via execa:**
```typescript
import { execa } from 'execa'

// Standard pattern used throughout
const result = await execa(command, args, {
  cwd: workingDirectory,
  env: process.env,
  stdio: 'pipe' | 'inherit',
  timeout: milliseconds,
  encoding: 'utf8'
})
```

### 5.2 Process Management

**Dev Server Detection:**
```typescript
// src/lib/process/ProcessManager.ts:42-92
async detectDevServer(port: number): Promise<ProcessInfo | null> {
  const platform = os.platform()

  if (platform === 'win32') {
    // Windows: netstat -ano
    const result = await execa('cmd', ['/c', 'netstat', '-ano'])
    // Parse output for :port and LISTENING state
  } else {
    // Unix: lsof -i :port
    const result = await execa('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'])
    const pid = parseInt(result.stdout.trim())
    // Verify it's actually a dev server via ps
  }
}
```

**Process Termination:**
```typescript
// src/lib/process/ProcessManager.ts:94-114
async terminateProcess(pid: number): Promise<void> {
  const platform = os.platform()

  if (platform === 'win32') {
    await execa('taskkill', ['/F', '/PID', String(pid)])
  } else {
    // Try graceful shutdown first
    process.kill(pid, 'SIGTERM')
    // Wait, then force kill if needed
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }, 5000)
  }
}
```

### 5.3 CLI Tool Isolation

**Symlink Creation for Parallel Execution:**
```typescript
// src/lib/CLIIsolationManager.ts:88-123
async createSymlinks(worktreePath: string, identifier: string): Promise<void> {
  const binConfig = this.packageJson.bin

  for (const [name, relPath] of Object.entries(binConfig)) {
    const targetPath = path.resolve(worktreePath, relPath)
    const symlinkName = `${name}-${identifier}`
    const symlinkPath = path.join(this.binDir, symlinkName)

    // Create symlink: cli-tool-25 → worktree/dist/cli.js
    await fs.symlink(targetPath, symlinkPath)
  }
}
```

---

## 6. Data Flow and State Management

### 6.1 Configuration Loading Hierarchy

```
Built-in Defaults (lowest priority)
         ↓
Project Settings (.iloom/settings.json)
         ↓
Local Overrides (.iloom/settings.local.json)
         ↓
CLI Arguments (--set flags, highest priority)
```

**Implementation:**
```typescript
// src/lib/SettingsManager.ts:89-134
async loadSettings(): Promise<IloomSettings> {
  // 1. Start with defaults
  let mergedSettings: IloomSettings = { ...DEFAULT_SETTINGS }

  // 2. Load and merge project settings
  const projectSettings = await this.loadProjectSettings()
  if (projectSettings) {
    mergedSettings = this.deepMerge(mergedSettings, projectSettings)
  }

  // 3. Load and merge local settings
  const localSettings = await this.loadLocalSettings()
  if (localSettings) {
    mergedSettings = this.deepMerge(mergedSettings, localSettings)
  }

  // 4. Apply CLI overrides
  if (this.overrides) {
    mergedSettings = this.applyOverrides(mergedSettings, this.overrides)
  }

  return mergedSettings
}
```

### 6.2 GitHub Data Flow

```
GitHub Issue/PR Request
         ↓
GitHub CLI (gh issue/pr view --json)
         ↓
GitHubService.fetchIssue/fetchPR
         ↓
Parse JSON response
         ↓
Transform to Issue/PullRequest type
         ↓
Extract context for Claude
         ↓
Post to GitHub comments (persistent storage)
```

### 6.3 Workspace State Tracking

**Worktree Information:**
```typescript
// src/lib/GitWorktreeManager.ts:19-51
interface ParsedWorktree {
  path: string           // Absolute path to worktree
  branch: string         // Current branch name
  commit: string         // HEAD commit SHA
  isMain: boolean        // Is this the main worktree
  prunable: boolean      // Can be pruned
  locked: boolean        // Is locked
  lockedReason?: string  // Why it's locked
}

// Parsed from: git worktree list --porcelain
```

**Active Process Tracking:**
- Port assignments tracked via PORT environment variable
- Process PIDs detected via lsof/netstat
- No persistent state file for processes (runtime detection only)

---

## 7. External Dependencies

### 7.1 Required CLI Tools

| Tool | Version | Detection Method | Required For |
|------|---------|-----------------|--------------|
| **git** | ≥2.5 | `git --version` | Core functionality |
| **gh** | Any | `which gh` | GitHub operations |
| **claude** | Any | `which claude` | AI assistance |
| **node** | ≥16 | `node --version` | JavaScript runtime |
| **pnpm/npm** | Any | Lock file detection | Package management |

### 7.2 Optional CLI Tools

| Tool | Purpose | Detection Method | Fallback |
|------|---------|-----------------|----------|
| **neon** | Database branching | `which neon` | Skip DB branching |
| **code** | VS Code launch | `which code` | Skip IDE launch |

### 7.3 Command Execution Timeouts

```typescript
// Default timeouts for external commands
GitHub CLI:     30000ms (30 seconds)
Git operations: 30000ms (30 seconds)
Claude CLI:     0 (no timeout - interactive)
Neon CLI:       30000ms (30 seconds)
Package install: 120000ms (2 minutes)
Validation:     300000ms (5 minutes)
```

---

## 8. File System Architecture

### 8.1 Directory Structure

```
<repository-root>/
├── .git/                          # Git repository
├── .iloom/                     # Configuration directory
│   ├── settings.json              # Project settings (committed)
│   ├── settings.local.json        # Local overrides (gitignored)
│   └── bin/ → ~/.iloom/bin/    # Symlink to global bin directory
│
├── .env                           # Main environment variables
├── .env.local                     # Local environment overrides
├── package.json                   # Project configuration
│
└── <worktree-prefix>/             # Worktree container
    ├── issue-25-add-auth/         # Issue workspace
    │   ├── .git                   # Worktree git file
    │   ├── .env                   # Copied + modified env
    │   ├── node_modules/          # Isolated dependencies
    │   └── [source files]         # Full project copy
    │
    └── pr-123-fix-bug/            # PR workspace
        └── [same structure]
```

### 8.2 Global User Directory

```
~/.iloom/
└── bin/                           # Global symlink directory
    ├── cli-tool-25 → /path/to/issue-25/dist/cli.js
    ├── cli-tool-26 → /path/to/issue-26/dist/cli.js
    └── cli-tool-pr-123 → /path/to/pr-123/dist/cli.js
```

### 8.3 File Permissions

```typescript
// File creation uses default umask
await fs.writeFile(path, content)  // No explicit permissions

// Symlink creation
await fs.symlink(target, link)     // No explicit permissions

// Directory creation
await fs.mkdir(dir, { recursive: true })  // Default permissions
```

---

## 9. Security Model

### 9.1 Trust Boundaries

```
Trusted Zone (Full Access)
├── Local file system
├── Process environment
├── User's git repositories
└── User's CLI tools

External Services (API Access)
├── GitHub API (via gh CLI)
├── Claude API (via claude CLI)
└── Neon API (via neon CLI)
```

### 9.2 Credential Management

**No Direct Credential Handling:**
- GitHub tokens: Managed by `gh` CLI
- Claude API keys: Managed by `claude` CLI
- Neon auth: Managed by `neon` CLI
- Database URLs: Stored in `.env` files

**Environment Variable Exposure:**
```typescript
// All child processes inherit full environment
{
  env: process.env  // Includes all secrets
}
```

### 9.3 Security Assumptions

1. **Local Execution Only**
   - User has full control of machine
   - No remote access to processes
   - File permissions protect secrets

2. **CLI Tool Security**
   - External CLIs manage credentials securely
   - No credential logging by CLIs
   - CLIs use secure storage (keychains)

3. **Process Isolation**
   - OS provides process boundaries
   - No cross-workspace contamination
   - Port conflicts prevented by allocation strategy

4. **File System Security**
   - `.env` files protected by filesystem permissions
   - `.gitignore` prevents credential commits
   - Symlinks don't expose sensitive data

---

## 10. Configuration System

### 10.1 Settings Schema

```typescript
// src/types/settings.ts
interface IloomSettings {
  mainBranch: string                    // Default: "main"
  worktreePrefix?: string                // Auto-calculated from repo
  protectedBranches: string[]           // Cannot be used for iloom
  databaseBranchPrefix?: string         // Prefix for Neon branches

  capabilities?: {
    web?: {
      basePort: number                 // Default: 3000
      command?: string                 // Override dev command
    }
  }

  workflows?: {
    issue?: WorkflowSettings
    pr?: WorkflowSettings
    regular?: WorkflowSettings
  }

  agents?: {
    [agentName: string]: {
      model?: string                   // Model override
      enabled?: boolean                // Enable/disable agent
    }
  }
}
```

### 10.2 Agent Configuration

**Agent Markdown Format:**
```markdown
---
name: iloom-issue-analyzer
description: Analyzes issue root causes
tools: ["read_file", "list_dir", "search_code"]
model: "claude-3-5-sonnet-20241022"
complexity: "complex"
phase: "analysis"
---

# Agent prompt content here...
```

**Agent Loading:**
```typescript
// src/lib/AgentManager.ts:38-76
async runAgent(agentName: string, context: AgentContext): Promise<string> {
  // 1. Load agent markdown file
  const agentPath = path.join(this.agentsDir, `${agentName}.md`)
  const agentContent = await fs.readFile(agentPath, 'utf-8')

  // 2. Parse frontmatter for metadata
  const { metadata, prompt } = this.parseAgent(agentContent)

  // 3. Get model from settings or metadata
  const model = this.getModelForAgent(agentName, metadata)

  // 4. Execute via Claude CLI
  const result = await this.claude.runPrompt(prompt, {
    model,
    workspacePath: context.workspacePath,
    permissionMode: context.permissionMode
  })

  return result
}
```

### 10.3 Workflow Configuration

```typescript
interface WorkflowSettings {
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions'
  noVerify?: boolean           // Skip git hooks
  startIde?: boolean           // Launch VS Code
  startDevServer?: boolean     // Start dev server
  startAiAgent?: boolean       // Launch Claude
  startTerminal?: boolean      // Open terminal
}
```

---

## 11. Error Handling Architecture

### 11.1 Error Propagation Model

```typescript
// Strict error propagation - no swallowing
try {
  const result = await operation()
  return result
} catch (error) {
  // Check for specific, expected errors
  if (error instanceof Error && error.message.includes('specific condition')) {
    // Handle known case
    throw new CustomError('Meaningful message', { cause: error })
  }
  // Always re-throw unknown errors
  throw error
}
```

### 11.2 GitHub Error Handling

```typescript
// src/lib/GitHubService.ts:45-89
async fetchIssue(issueNumber: number): Promise<Issue> {
  try {
    const output = await githubUtils.fetchIssue(issueNumber)
    return JSON.parse(output) as Issue
  } catch (error) {
    // Only handle specific GitHub CLI error
    if (error instanceof Error &&
        error.stderr?.includes('Could not resolve')) {
      throw new GitHubError(
        `Issue #${issueNumber} not found`,
        'ISSUE_NOT_FOUND'
      )
    }
    throw error  // Re-throw all other errors
  }
}
```

### 11.3 Validation Error Handling

```typescript
// src/lib/ValidationRunner.ts
async runValidations(): Promise<ValidationResult> {
  const results = []

  // Run each validation, collect results
  for (const validation of validations) {
    try {
      await this.runValidation(validation)
      results.push({ name: validation, success: true })
    } catch (error) {
      results.push({
        name: validation,
        success: false,
        error: error.message
      })
      // Continue to next validation (fail-fast optional)
    }
  }

  return results
}
```

---

## 12. Key Architectural Patterns

### 12.1 CLI Tool Abstraction

**Pattern:** All external tools wrapped in utility functions
```typescript
External Tool → Utility Wrapper → Service Layer → Command Layer
     gh      →  github.ts      → GitHubService → StartCommand
```

**Benefits:**
- Consistent error handling
- Timeout management
- Logging/debugging
- Testability via mocking

### 12.2 Workspace Isolation

**Pattern:** Each issue/PR gets isolated environment
```typescript
Workspace = {
  Git Worktree +
  Environment Variables +
  Dependencies +
  Database Branch +
  Port Allocation +
  CLI Namespace
}
```

**Benefits:**
- No conflicts between concurrent work
- Clean environment per issue
- Easy cleanup
- Parallel development

### 12.3 Context Persistence

**Pattern:** GitHub comments as persistent storage
```typescript
Analysis Results → GitHub Comment → Team Visibility
                                  → Future Reference
                                  → Audit Trail
```

**Benefits:**
- Context survives session end
- Team collaboration
- Historical record
- No local state files

### 12.4 Model Selection Strategy

**Pattern:** Task-appropriate model selection
```typescript
Quick Operations → Haiku (fast, cheap)
  - Branch naming
  - Commit messages

Complex Analysis → Sonnet/Opus (powerful)
  - Issue analysis
  - Planning
  - Implementation
```

---

## 13. Performance Characteristics

### 13.1 Operation Timing

| Operation | Typical Duration | Bottleneck |
|-----------|-----------------|------------|
| **Issue Fetch** | 1-3 seconds | GitHub API |
| **Branch Name Generation** | 2-5 seconds | Claude API |
| **Worktree Creation** | 1-10 seconds | Repo size |
| **Dependency Install** | 30-300 seconds | Package count |
| **Database Branch** | 5-15 seconds | Neon API |
| **Agent Execution** | 5-30 seconds each | Claude API |
| **Validation Suite** | 10-300 seconds | Test complexity |
| **Rebase/Merge** | 1-60 seconds | Conflict complexity |

### 13.2 Parallel Operations

**Concurrent During Start:**
- VS Code launch
- Dev server start
- Claude CLI launch

**Sequential Operations:**
- Git operations (worktree, rebase, merge)
- Validation pipeline (typecheck → lint → test)
- Agent execution (analysis → planning)

### 13.3 Resource Usage

**Per Workspace:**
- Disk: Full repository copy + node_modules
- Memory: Dev server instance
- Port: One dedicated port
- Database: One branch connection

**Scaling Limits:**
- Theoretical: Unlimited workspaces
- Practical: ~20-30 (disk/memory constraints)
- Port range: 100 ports (3000-3099 typical)

---

## 14. Monitoring and Logging

### 14.1 Logging Architecture

```typescript
// src/utils/logger.ts
class Logger {
  private debugEnabled = process.env.DEBUG === 'true'

  debug(message: string, ...args: any[]): void {
    if (this.debugEnabled) {
      console.error(`[DEBUG] ${message}`, ...args)
    }
  }

  info(message: string): void {
    console.log(message)
  }

  error(message: string, error?: Error): void {
    console.error(message, error)
  }
}
```

### 14.2 Debug Information

**What Gets Logged in Debug Mode:**
- Git command execution
- GitHub API calls
- Process detection results
- File operations
- Agent execution
- Configuration loading

**What Never Gets Logged:**
- Credential values
- Full environment dumps
- Sensitive file contents

---

## 15. Summary of Architectural Decisions

### Design Principles

1. **Delegation Over Implementation**
   - Delegate auth to CLI tools vs implementing OAuth
   - Use existing CLIs vs API clients
   - Leverage OS facilities vs custom solutions

2. **Explicit Over Implicit**
   - Explicit error checking
   - Explicit environment passing
   - Explicit configuration merging

3. **Isolation Over Sharing**
   - Separate worktree per issue
   - Isolated dependencies
   - Independent database branches

4. **Persistence Over Ephemeral**
   - GitHub comments for context
   - Configuration in files
   - No in-memory session state

5. **Fail-Fast Over Recovery**
   - Validation stops on first failure
   - Errors propagate immediately
   - No automatic retry logic

### Trade-offs Made

| Decision | Benefit | Cost |
|----------|---------|------|
| **CLI tool dependency** | No credential management | Requires local installation |
| **Full env inheritance** | Simple implementation | Potential secret exposure |
| **Worktree isolation** | Clean environments | Disk space usage |
| **GitHub comment storage** | Persistent context | API rate limits |
| **Synchronous execution** | Predictable flow | Slower operations |
| **No daemon process** | Simplicity | No background operations |

### Constraints and Assumptions

**Hard Requirements:**
- Git 2.5+ for worktree support
- GitHub repository as source
- Local filesystem access
- Node.js runtime environment

**Soft Requirements:**
- macOS/Linux preferred (Windows untested)
- VS Code for IDE integration
- pnpm for package management
- Neon for database branching

**Assumptions:**
- Single repository workflow
- Main branch as integration target
- Issue/PR-driven development
- Local development environment
- Trust in CLI tool security