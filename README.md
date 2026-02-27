iloom
=====
<div align="center">

[![npm](https://img.shields.io/npm/v/%40iloom%2Fcli?label=npm)](https://www.npmjs.com/package/@iloom/cli)
[![License: BSL-1.1](https://img.shields.io/badge/license-BSL--1.1-lightgrey)](https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/built%20for-claude%20code-8A6FFF)](https://claude.ai/)
[![CI](https://github.com/iloom-ai/iloom-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/iloom-ai/iloom-cli/actions/workflows/ci.yml)

</div>

> **[VS Code extension](https://marketplace.visualstudio.com/items?itemName=iloom-ai.iloom-vscode) now available!** Run `il vscode` to install. Get the recap panel to see AI decisions, risks, and assumptions in real-time, plus the loom explorer to manage and switch between active projects and tasks.

<div align="center">
  <img width="600" alt="iloom-ai-screenshot" src="https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/assets/iloom_dag.png" />
  <div>iloom in action: Scale understanding, not just output.</div>
</div>

#### Links to key sections

[How It Works](#how-it-works-the-multi-agent-workflow) • [Installation](#quick-start) • [Configuration](#configuration) • [Advanced Features](#advanced-features) • [Swarm Mode](#swarm-mode-epic-orchestration) • [Telemetry](#telemetry) • [Limitations](#system-requirements--limitations) • [Contributing](#contributing-to-iloom)

## How can your team trust the code your AI wrote, when you don't?

Your agent just shipped a 2,000-line PR. Why did it restructure that module? What assumptions did it make about the auth flow? Nobody knows. The reasoning evaporated when the chat session ended, and now your teammate is staring at a diff with zero context. Good luck getting that reviewed.

iloom persists the AI's analysis, plans, decisions, and risks as comments in your issue tracker. Not chat logs you'll never reopen. Not markdown files littering the repo. Your actual tracker, where your team can see what happened and why. That mountain of code you're sending for review? Now it comes with the reasoning behind it.

This matters because to get the most out of agents, you need to be multitasking across several of them. iloom gives every task its own isolated environment (git worktree, DB branch, unique port), and because all the reasoning is persisted, you can context-switch between tasks without losing the thread. The [VS Code extension](https://marketplace.visualstudio.com/items?itemName=iloom-ai.iloom-vscode) lets you catch up with any agent in seconds. Your teammates can pick up where you left off without a briefing.

When a task outgrows one agent, `il plan` decomposes it into child issues with dependencies, and swarm mode launches parallel agents to execute them, each in its own worktree, running the full iloom workflow. You can one-shot entire features, entire products, and stay aligned. The VS Code extension gives you a Kanban board and dependency graph so you can see what's running, what's blocked, and what's done. The only real limit is your imagination. And maybe your Claude subscription.

Quick Start
-----------

iloom uses your existing Claude subscription to build a shared mental model of your task.
```bash
 # 1. Install iloom
 npm install -g @iloom/cli
 
 # 2. Authenticate (iloom uses the GitHub CLI) 
 gh auth login 
 
 # 3. Start a Loom 
 # Spins up an isolated environment (Git worktree, DB branch, unique port).
 # Analyzes the issue, plans the work, and documents the plan in issue comments.
 il start 25 

 # ... You, the iloom agents and Claude build the feature together in the isolated environment ...
 
 # 4. Finish & Merge  # Validates code, generates session summary, merges, and cleans up.
 il finish
 ```

**The iloom Difference:** il start doesn't merely create a branch. It launches a multi-agent workflow that surfaces assumptions and creates a structured plan in your issue tracker **before you even need to look at your IDE.**

How It Works: The Multi-Agent Workflow
--------------------------------------

When you run il start, iloom orchestrates specialized AI agents. Each has a specific role and writes structured output to **issue comments**, creating permanent project knowledge.

### 1. The Agents

Instead of a single generic prompt, iloom uses a pipeline of specialized agents:

*   **Enhancer:** Expands brief one-liners into detailed requirements with acceptance criteria.

*   **Evaluator:** Assesses complexity and routes to the appropriate workflow:

    *   **Simple:** Combines analysis and planning into one step for efficiency.

    *   **Complex:** Separates deep analysis from detailed planning for thorough coverage.

*   **Analyzer:** Explores the problem space before any code is written. This agent investigates the codebase to understand existing patterns, examines third-party library APIs and capabilities, and researches technical approaches. The result is a comprehensive analysis that informs the planning phase—leading to significantly better implementation plans than jumping straight to code.

*   **Planner:** Creates an execution plan with parallelization analysis—identifying which steps can run concurrently vs. sequentially. Plans reference specific files and line numbers, making them actionable and precise.

*   **Implementer:** Executes the plan using the context established in the previous steps. For complex tasks, multiple implementers can run in parallel on independent steps.

*   **Swarm Orchestrator:** For epics with child issues, iloom enters [swarm mode](#swarm-mode-epic-orchestration)—launching parallel agent teams that implement each child issue autonomously in its own worktree, respecting dependency order.
    

### 2. Interactive Control

You are in the loop at every stage. You can review the AI's analysis, edit the plan in GitHub/Linear, and adjust course before implementation begins.

*   **Default Mode:** You approve each phase (Enhance → Plan → Implement).

*   **--one-shot Mode:** Automate the pipeline with different levels of control.

*   **--yolo Mode:** Feeling lucky? Shorthand for `--one-shot=bypassPermissions` - full automation without prompts.
    

### 3. The Environment

Each loom is a fully isolated container for your work:

*   **Git Worktree:** A separate filesystem at ~/project-looms/issue-25/. No stashing, no branch switching overhead.
    
*   **Database Branch:** (Neon support) Schema changes in this loom are isolated—they won't break your main environment or your other active looms.

*   **Environment Variables:** Each loom has its own environment files (`.env`, `.env.local`, `.env.development`, `.env.development.local`). Uses `development` by default, override with `DOTENV_FLOW_NODE_ENV`. See [Secret Storage Limitations](#multi-language-project-support) for frameworks with encrypted credentials.

    When inside a loom shell (`il shell`), the following environment variables are automatically set:

    | Variable | Description | Example |
    |----------|-------------|---------|
    | `ILOOM_LOOM` | Loom identifier for PS1 customization | `issue-87` |
    | `ILOOM_COLOR_HEX` | Hex color assigned to this loom (if available) | `#dcebff` |

    `ILOOM_COLOR_HEX` is useful for downstream tools that want to visually distinguish looms. For example, a Vite app can read it via `import.meta.env.VITE_ILOOM_COLOR_HEX` to tint the UI. See [Vite Integration Guide](docs/vite-iloom-color.md) for details.

*   **Unique Runtime:**
    
    *   **Web Apps:** Runs on a deterministic port (e.g., base port 3000 + issue #25 = 3025).
        
    *   **CLI Tools:** Creates an isolated binary copy (e.g., my-tool-25). You can run issue #25's version of your CLI alongside issue #99's version without conflicts. (Fun fact: iloom was built with iloom using this feature).
        
*   **Context Persistence:** All reasoning is stored in issue comments. This makes the "why" behind the code visible to your teammates and your future self.
    

Command Reference
-----------------

| **Command** | **Alias** |  **Description** |
| ------ | ----- | -----|
| `il start` | `new` | Create loom, run analysis agents, and launch IDE. Auto-detects epics with child issues for [swarm mode](#swarm-mode-epic-orchestration). |
| `il commit` | `c` | Commit all files with issue reference (`Refs #N` or `Fixes #N`). |
| `il finish` | `dn` | Validate tests/lint, commit, handle conflicts, and merge/PR. |
| `il cleanup` | `remove` | Safely remove a loom and its database branch without merging. |
| `il list` |  | Show active looms for current project. `--finished` for archived, `--all` for active + archived, `--global` for looms across all projects. JSON output includes `swarmIssues` and `dependencyMap` for epic looms. |
| `il projects` |  | List configured projects (JSON output). |
| `il spin` |  | Launch Claude inside the current loom with context auto-detected. In epic looms, enters [swarm mode](#swarm-mode-epic-orchestration) with parallel agent orchestration. |
| `il open` | `run` | Open loom in browser (web) or run your CLI tool. |
| `il vscode` |  | Install iloom VS Code extension and open workspace in VS Code. |
| `il dev-server` | `dev` | Start dev server in foreground for a workspace. |
| `il build` |  | Run the build script for a workspace. |
| `il lint` |  | Run the lint script for a workspace. |
| `il test` |  | Run the test script for a workspace. |
| `il compile` | `typecheck` | Run the compile or typecheck script for a workspace. |
| `il add-issue` | `a` | Create and AI-enhance a new issue without starting work yet. |
| `il plan` |  | Launch interactive planning session to decompose epics into child issues. |
| `il contribute` |  | Fork, clone, and set up a GitHub repo for contribution (defaults to iloom-cli). |
| `il init` | `config` | Interactive configuration wizard. |
| `il feedback` | `f` | Submit bug reports/feedback directly from the CLI. |
| `il update` |  | Update iloom CLI to the latest version. |
| `il telemetry` |  | Manage anonymous usage telemetry (`on`, `off`, `status`). |

For detailed documentation including all command options, flags, and examples, see the [Complete Command Reference](docs/iloom-commands.md).

Configuration
-------------

### 1. Interactive Setup (Recommended)

The easiest way to configure iloom is the interactive wizard. It guides you through setting up your environment (GitHub/Linear, Neon, IDE).

You can even use natural language to jump-start the process:

```bash
# Standard wizard
il init 

# Natural language wizard
il init "set my IDE to windsurf and help me configure linear"
```   

### 2. Manual Configuration

Settings are loaded in this order (highest priority first):

1.  **CLI Flags:** il start --permissionMode=acceptEdits
    
2.  **Local Overrides:** .iloom/settings.local.json (gitignored; for API keys & local preferences)
    
3.  **Project Settings:** .iloom/settings.json (committed; for shared team defaults)
    
4.  **Global Settings:** ~/.config/iloom-ai/settings.json (for user-specific defaults)
    

### Key Settings Example

This example shows how to configure a project-wide default (e.g., GitHub remote) while keeping sensitive keys (Linear API token) or personal preferences (IDE choice) local.

**.iloom/settings.json (Committed)**

```json
{
  "mainBranch": "main",
  "issueManagement": {
    "provider": "github"
  },
  "capabilities": {
    "web": {
      "basePort": 3000
    },
    "database": {
      "databaseUrlEnvVarName": "DATABASE_URL"
    }
  },
  "databaseProviders": {
    "neon": {
      "projectId": "fantastic-fox-3566354"
    }
  }
}
```

**.iloom/settings.local.json (Gitignored)**

```json
{
  "issueManagement": {
    "linear": {
      "apiToken": "lin_api_..." // Only if using Linear
    }
  },
  "workflows": {
    "issue": {
      "permissionMode": "acceptEdits" // Control Claude Code permissions
    }
  },
  "spin": {
    "model": "opus" // Claude model for spin orchestrator: opus (default), sonnet, or haiku
  },
  "summary": {
    "model": "sonnet" // Claude model for session summaries: sonnet (default), opus, or haiku
  }
}
```

### Multi-Language/Framework Project Support

iloom supports projects in any programming language through `.iloom/package.iloom.json`. This file defines scripts using raw shell commands instead of npm scripts.

**File Location:** `.iloom/package.iloom.json`

**Format:**
```json
{
  "scripts": {
    "install": "bundle install",
    "build": "cargo build --release",
    "test": "cargo test",
    "dev": "cargo run",
    "lint": "cargo clippy",
    "typecheck": "cargo check"
  }
}
```

**Supported Scripts:**

| Script | Purpose | When Used |
|--------|---------|-----------|
| `install` | Install dependencies | `il start` (loom creation), `il finish` (post-merge) |
| `build` | Compile/build project | `il build`, `il finish` (CLI projects, post-merge) |
| `test` | Run test suite | `il test`, `il finish` validation |
| `dev` | Start dev server | `il dev-server` |
| `lint` | Run linter | `il lint`, `il finish` validation |
| `typecheck` | Type checking | `il typecheck`, `il finish` validation |
| `compile` | Alternative to typecheck | `il compile`, `il finish` validation (preferred over typecheck if both exist) |

All scripts are optional. If not defined, that step is skipped.

**Language Examples:**

| Language | Install | Build | Test | Dev | Lint | Typecheck |
|----------|---------|-------|------|-----|------|-----------|
| Rust | `cargo fetch` | `cargo build` | `cargo test` | `cargo run` | `cargo clippy` | `cargo check` |
| Python (pip) | `pip install -e .` | - | `pytest` | `uvicorn app:app` | `ruff check .` | `mypy .` |
| Python (poetry) | `poetry install` | - | `pytest` | `uvicorn app:app` | `ruff check .` | `mypy .` |
| Ruby | `bundle install` | - | `bundle exec rspec` | `rails server` | `bundle exec rubocop` | - |
| Go | `go mod download` | `go build ./...` | `go test ./...` | `go run .` | `golangci-lint run` | `go vet ./...` |

**Precedence Rules:**
1. `.iloom/package.iloom.json` (if exists) - highest priority
2. `package.json` (if exists) - fallback for Node.js projects

**Key Differences from package.json:**
- Scripts are raw shell commands, executed directly (not via npm/pnpm)
- No package manager prefix is added to commands
- Works with any language's toolchain

**Automatic Detection:** When running `il init` on a non-Node.js project, iloom will offer to detect your project's language and generate an appropriate `package.iloom.json`.

**→ [Complete Multi-Language Project Guide](docs/multi-language-projects.md)** - Detailed setup instructions, more language examples, and troubleshooting.

**Secret Storage Limitations:** iloom manages environment variables through standard `.env` files (via dotenv-flow). The following encrypted/proprietary secret storage formats are **not supported**:

| Format | Why Unsupported |
|--------|-----------------|
| Rails encrypted credentials (`config/credentials.yml.enc`) | Requires Rails internals + master key |
| ASP.NET Core User Secrets | Stored outside project at `~/.microsoft/usersecrets/<guid>/` |
| SOPS/Sealed Secrets | Requires external decryption keys |

**Recommendation:** If you want to use database isolation features (or anything else that requires updating env variables), use standard `.env` files for iloom compatibility. For Rails, consider [dotenv-rails](https://github.com/bkeepers/dotenv). For ASP.NET, use a local `.env` file alongside User Secrets.

### Copying Gitignored Files to Looms

By default, looms only contain files tracked by Git. If you have local files that are gitignored (like SQLite databases, test data, or sensitive configuration), they won't be available in your looms.

**Automatically copied:** Some gitignored files are always copied to looms without configuration:
- dotenv-flow files: `.env`, `.env.local`, `.env.development`, `.env.development.local`
- `.iloom/settings.local.json`
- `.claude/settings.local.json`

For other gitignored files, use `copyGitIgnoredPatterns` to specify glob patterns for files that should be copied from your main repo to each loom.

**When to use:**
- **Local databases:** SQLite files (`*.db`, `*.sqlite`) for local development
- **Test data:** Large test fixtures that are too big to commit to git
- **Sensitive files:** Configuration files with credentials that shouldn't be in version control

**.iloom/settings.json**

```json
{
  "copyGitIgnoredPatterns": [
    "*.db",
    "*.sqlite",
    "data/**/*.json",
    "{data,fixtures}/*.sql"
  ]
}
```

**Supported patterns:**
- `*.db` - Match files with .db extension in root
- `**/*.db` - Recursively match all .db files in any directory
- `data/**/*.sqlite` - Match .sqlite files anywhere under data/
- `{data,backup}/*.db` - Match .db files in either data/ or backup/
- `*.{db,sqlite}` - Match files with either .db or .sqlite extension

**Notes:**
- Files are copied from your main workspace to each loom during `il start`
- Files are NOT copied back during `il finish` (one-way copy only)
- The patterns use [fast-glob](https://github.com/mrmlnc/fast-glob) syntax

### Merge Behavior

Control how `il finish` handles your work. Configure in `.iloom/settings.json`:

```json
{
  "mergeBehavior": {
    "mode": "local"  // "local", "github-pr", or "github-draft-pr"
  }
}
```

| **Mode** | **Description** |
|----------|-----------------|
| `local` | (Default) Merge directly into main branch locally. Fast-forward merge, no PR created. |
| `github-pr` | Push branch and create a GitHub PR on `il finish`. Worktree cleanup is optional. |
| `github-draft-pr` | Create a draft PR immediately on `il start`. On `il finish`, the PR is marked ready for review. **Recommended for contributions to forked repos.** |

### Artifact Review

iloom can optionally review workflow artifacts (enhancements, analyses, implementation plans) before posting them to issues. This helps catch quality issues early and ensures artifacts meet project standards.

**Supported Agents for Review:**

| Agent | Artifact Type |
|-------|---------------|
| `iloom-issue-enhancer` | Issue enhancements |
| `iloom-issue-analyzer` | Technical analyses |
| `iloom-issue-planner` | Implementation plans |
| `iloom-issue-analyze-and-plan` | Combined analysis and plans |
| `iloom-issue-implementer` | Implementation summaries |
| `iloom-issue-complexity-evaluator` | Complexity assessments |

**Configuration:**

```json
{
  "agents": {
    "iloom-artifact-reviewer": {
      "enabled": true,
      "providers": {
        "claude": "sonnet",
        "gemini": "gemini-3-pro-preview"
      }
    },
    "iloom-issue-planner": {
      "review": true
    },
    "iloom-issue-analyzer": {
      "review": true
    }
  }
}
```

- `iloom-artifact-reviewer.providers`: Configure which AI providers to use for review (claude, gemini, codex)
- `review: true` on workflow agents: Enable artifact review for that agent's output

When review is enabled, the artifact reviewer validates quality and completeness against artifact-specific criteria before posting. If issues are found, you can choose to revise or proceed.

**Tip:** For high-stakes projects, enable review on `iloom-issue-planner` to catch issues in implementation plans before development begins.

### Rebase Conflict Resolution

When `il finish` or `il rebase` encounter rebase conflicts, iloom automatically launches Claude to help resolve them. During conflict resolution, the following git commands are **auto-approved** so Claude can work efficiently without requiring manual permission for each command:

- `git status` - View current rebase state
- `git diff` - Examine conflicts
- `git log` - Understand branch history
- `git add` - Stage resolved files
- `git rebase` - Continue or abort rebase

Note: Potentially destructive commands like `git reset` and `git checkout` are intentionally not auto-approved to prevent accidental data loss.

**When to use `github-draft-pr`:**
- **Contributing to forks:** When you don't are contributing to a forked repo use this mode to create the PR from your fork immediately, allowing iloom's agents to post workflow comments directly to the PR instead of writing to the upstream repo's issues (which may not be appreciated by the repo owners).
- CI runs on your branch during development (draft PRs trigger CI on most repos)
- Your team requires PRs for all changes (no direct merges to main)
- You want reviewers to see progress before the work is complete

Integrations
------------

### Issue Trackers

iloom supports multiple issue tracking providers to fit your team's workflow.

| **Provider** | **Setup** | **Notes** |
|--------------|-----------|-----------|
| **GitHub**   | `gh auth login` | Default. Supports Issues and Pull Requests automatically. |
| **Linear**   | `il init` | Requires API token. Supports full read/write on Linear issues. |
| **Jira**     | Configure in `.iloom/settings.json` | Atlassian Cloud. Requires API token. See [Jira Setup](#jira-setup) below. |

### Jira Setup

To use Jira as your issue tracker, add this configuration:

**.iloom/settings.json (Committed)**
```json
{
  "issueManagement": {
    "provider": "jira",
    "jira": {
      "host": "https://yourcompany.atlassian.net",
      "username": "your.email@company.com",
      "projectKey": "PROJ",
      "boardId": "123",
      "doneStatuses": ["Done", "Closed"],
      "transitionMappings": {
        "In Review": "Start Review"
      }
    }
  }
}
```

**.iloom/settings.local.json (Gitignored - Never commit this file)**
```json
{
  "issueManagement": {
    "jira": {
      "apiToken": "your-jira-api-token-here"
    }
  }
}
```

**Generate a Jira API Token:**
1. Visit https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token to `.iloom/settings.local.json`

**Configuration Options:**
- `host`: Your Jira Cloud instance URL
- `username`: Your Jira email address
- `apiToken`: API token (store in settings.local.json only!)
- `projectKey`: Jira project key (e.g., "PROJ", "ENG")
- `boardId`: (Optional) Board ID for sprint/workflow operations
- `doneStatuses`: (Optional) Status names to exclude from `il issues` lists (default: `["Done"]`). Set to match your Jira workflow, e.g., `["Done", "Closed", "Verified"]`
- `transitionMappings`: (Optional) Map iloom states to your Jira workflow transition names


### IDE Support
iloom creates isolated workspace settings for your editor. Color synchronization (visual context) only works best VS Code-based editors.

*   **Supported:** VS Code, Cursor, Windsurf, Antigravity, WebStorm, IntelliJ, Sublime Text.
    
*   **Config:** Set your preference via `il init` or `il start --set ide.type=cursor`.

### Git Operation Settings

Configure git operation timeouts for projects with long-running pre-commit hooks.

**.iloom/settings.json**
```json
{
  "git": {
    "commitTimeout": 120000
  }
}
```

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `git.commitTimeout` | 60000 (60s) | 1000-600000 | Timeout in milliseconds for git commit operations. Increase if pre-commit hooks (linting, tests, type checking) exceed the default timeout. |

**When to increase:** If you see timeout errors during `il commit` or `il finish`, your pre-commit hooks are taking longer than the default 60 seconds. Set a higher value based on your typical hook duration.


Advanced Features
-----------------

### Child Looms (Nested Contexts)

Sometimes a task spawns sub-tasks, or you get interrupted by an urgent bug while deep in a feature. Child looms let you create a workspace _within_ a workspace.

**When to use:**

*   Breaking down a massive feature into smaller PRs.
    
*   Fixing a bug discovered during feature work without losing context.
    

**How it works:** If you run il start 42 while inside loom-25, iloom asks if you want to create a child loom.

*  **Inheritance:** The child inherits the database state and git branch from the parent (not main).
    
*  **Structure**
```
    ~/my-project-looms/
    ├── feat-issue-25-auth/           # Parent Loom
    └── feat-issue-25-auth-looms/     # Child Looms Directory
      ├── fix-issue-42-bug/         # Child Loom (inherits from #25)
      └── feat-issue-43-subtask/    # Another Child Loom
```

### CLI Tool Development

iloom provides first-class support for building CLI tools. When you start a loom for a CLI project, iloom creates workspace-specific binaries so you can test each issue's version independently.


```bash
> il start 52 # Working on CLI feature in issue 52

> my-cli-52 --version  # Test issue 52's version

> il start 137  # Switch to different CLI issue

> my-cli-137 --help    # Test issue 137's version

# Original binary still works from main branch
> my-cli --version     # Unaffected by other looms' CLIs
```

### Epic Planning and Decomposition

The `il plan` command launches an interactive Architect session that helps you break down complex features into manageable child issues.

**Two Operating Modes:**

```bash
# Fresh planning - start from a topic
il plan "Build user authentication system"

# Decomposition - break down an existing issue
il plan 42
```

**Multi-AI Provider Support:** Configure different AI providers for planning and review phases:

```bash
il plan --planner gemini --reviewer claude "Add OAuth support"
```

**Autonomous Mode:** Skip prompts and let the Architect work independently:

```bash
il plan --yolo "Add GitLab integration"
```

See the [Complete Command Reference](docs/iloom-commands.md#il-plan) for all options including `--model`, `--planner`, and `--reviewer` flags.

### Swarm Mode (Epic Orchestration)

Swarm mode enables automatic, parallel execution of an entire epic by coordinating a team of AI agents. Each child issue gets its own worktree and agent, all working simultaneously while respecting dependency order.

**Prerequisite:** Decompose your epic into child issues with dependencies first, using `il plan` or manually creating child issues and setting up blocking relationships.

**How to trigger:**

```bash
# Auto-detect: iloom checks for child issues and prompts
il start 100

# Force epic mode (skip prompt)
il start 100 --epic

# Force normal loom even if children exist
il start 100 --no-epic
```

When you run `il spin` inside the epic loom, swarm mode activates:

1. **Child worktrees** are created for each child issue, branched off the epic branch
2. **Swarm agents and skill files** are rendered into the epic loom's `.claude/` directory
3. **Dependency DAG** is fetched from your issue tracker (blocking relationships between children)
4. **Orchestrator launches** with Claude's experimental agent teams, using `bypassPermissions` mode
5. **Parallel agents** are spawned for all unblocked child issues simultaneously
6. As agents complete, their work is **rebased and fast-forward merged** into the epic branch
7. **Newly unblocked issues** are spawned automatically as their dependencies finish
8. **Failed children** are isolated — they don't block unrelated issues

**Example workflow:**

```bash
# 1. Plan and decompose your epic
il plan 100

# 2. Start the epic loom (auto-detects children)
il start 100 --epic

# 3. Launch swarm mode
il spin
# The orchestrator takes over — parallel agents implement each child issue,
# merge completed work, and handle failures autonomously.
```

Each child issue tracks its lifecycle state: `pending` -> `in_progress` -> `done` / `failed`. Use `il list --json` to see `swarmIssues` with per-child states and the `dependencyMap` for epic looms.

For detailed reference on swarm mode behavior, see the [Complete Command Reference](docs/iloom-commands.md#swarm-mode-epic-orchestration).

Telemetry
---------

iloom collects anonymous usage data to help improve the product. This data helps us understand which features are used, identify common errors, and prioritize development efforts.

**What IS collected:**
- Anonymous event data: command usage, feature adoption, and error types
- An anonymous identifier (not linked to your identity)

**What is NOT collected:**
- GitHub/Linear/Jira usernames or emails
- Repository names or URLs
- Issue titles, descriptions, or content
- File paths or code content
- Branch names
- AI analysis or plan content
- Anything that could identify a specific project or person

**Opt out at any time:**

```bash
# Disable telemetry
il telemetry off

# Check current status
il telemetry status

# Re-enable telemetry
il telemetry on
```

On first run, iloom displays a disclosure message informing you that telemetry is enabled and how to opt out.

System Requirements & Limitations
---------------------------------

This is an early-stage product.

**Requirements:**

*   ✅ **OS:** macOS (Fully supported). ⚠️ Linux/Windows are untested.
    
*   ✅ **Runtime:** Node.js 16+, Git 2.5+.
    
*   ✅ **AI:** Claude CLI installed. A Claude Max subscription is recommended (iloom uses your subscription).
    

**Project Support:**

*   ✅ **Node.js Web Projects:** First-class support via package.json scripts (dev, test, build).

*   ✅ **Node.js CLI Tools:** Full support with isolated binary generation.

*   ✅ **Multi-Language Projects:** Python, Rust, Ruby, Go, and other languages via `.iloom/package.iloom.json`.    

See all [known limitations](https://github.com/iloom-ai/iloom-cli/issues?q=is:issue+is:open+label:known-limitation) on GitHub. If you're feeling left out - you're absolutely right! The best way to complain about something is to fix it. So...

Contributing to iloom
---------------------

We (Claude and I) welcome contributions! iloom can set up its own dev environment:

```bash
iloom contribute   # Handles forking, cloning, and dev setup automatically
```

**PR Requirements:** All PRs should be created with iloom or include detailed context. If you're not using iloom, please provide equivalent detail explaining your approach and reasoning.

New contributors should start with issues labeled [starter-task](https://github.com/iloom-ai/iloom-cli/issues?q=is%3Aissue+is%3Aopen+label%3Astarter-task). For details, see our [Contributing Guide](CONTRIBUTING.md).

Contributing to Open Source
---------------------------

iloom streamlines the fork → clone → setup → PR workflow for any GitHub repository:

```bash
# Full URL format
iloom contribute "https://github.com/n8n-io/n8n"

# Shortened URL format
iloom contribute "github.com/n8n-io/n8n"

# owner/repo format
iloom contribute "n8n-io/n8n"
```

This command:
1. Forks the repository (if not already forked)
2. Clones your fork locally
3. Configures iloom for the project
4. Sets merge behavior to `github-draft-pr` (creates a draft PR immediately when you start work)

The draft PR workflow is ideal for open source: as you work, iloom posts the AI's analysis, implementation plan, and progress directly to that draft PR—giving maintainers full context before the code is even ready for review.

Acknowledgments
----------------

- [@NoahCardoza](https://github.com/NoahCardoza) — Jira Cloud integration (PR [#588](https://github.com/iloom-ai/iloom-cli/pull/588)): JiraApiClient, JiraIssueTracker, ADF/Markdown conversion, MCP provider, sprint/mine filtering, and `il issues` Jira support.

License & Name
--------------

**iloom** comes from "illuminate" (illuminating the AI coding process) and "intelligent loom" (weaving artificial and human intelligence together).

**License: Business Source License 1.1**

*   ✅ Free to use for any internal or commercial project.
    
*   ❌ You cannot resell iloom itself as a product or SaaS.
    
*   Converts to Apache 2.0 on 2030-02-25.
    

See [LICENSE](https://raw.githubusercontent.com/iloom-ai/iloom-cli/main/LICENSE) for complete terms.

**Terms of Service**

By using iloom, you agree to our [Terms of Service](https://iloom.ai/terms).
