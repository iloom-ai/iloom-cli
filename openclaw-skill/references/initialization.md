# Initialization (Manual Setup)

How to set up iloom for a project without using the interactive `il init` wizard.

## When to Use This

Use manual initialization instead of `il init` when:
- You are an AI agent and cannot reliably drive the interactive wizard
- You want deterministic, reproducible setup
- You need to initialize many projects quickly

## Prerequisites

1. The project must be a **git repository** with at least one commit
2. The project must have a **remote** configured (for GitHub issue tracking)
3. iloom CLI must be installed (`il --version` to verify)

## Step-by-Step Setup

### 1. Create the `.iloom` directory

```bash
mkdir -p <project-root>/.iloom
```

### 2. Create `.iloom/settings.json` (project settings — committed to git)

This file contains shared project configuration. At minimum:

```json
{
  "mainBranch": "main"
}
```

A typical project setup:

```json
{
  "mainBranch": "main",
  "colors": {
    "terminal": true,
    "vscode": true
  },
  "mergeBehavior": {
    "mode": "github-draft-pr"
  }
}
```

### 3. Create `.iloom/settings.local.json` (personal settings — gitignored)

This file contains per-developer preferences that should NOT be committed:

```json
{
  "workflows": {
    "issue": {
      "permissionMode": "acceptEdits"
    }
  }
}
```

### 4. Configure GitHub Remote (Fork Workflows)

If the project has **multiple git remotes** (e.g., a fork workflow), configure which remote iloom uses for issue tracking vs. pushing. **Do not guess — ask the user.**

Add to `.iloom/settings.local.json` (not `settings.json`, since this is per-developer):

```json
{
  "issueManagement": {
    "github": {
      "remote": "upstream"
    }
  },
  "mergeBehavior": {
    "remote": "origin"
  }
}
```

**Standard convention:** `origin` = your fork, `upstream` = the original repo. iloom assumes `origin` is yours by default.

**Understanding the two settings:**
- **`issueManagement.github.remote`** — The canonical GitHub repository for all GitHub operations: listing/creating issues, **opening PRs**, commenting, closing issues. PRs are opened against this repo.
- **`mergeBehavior.remote`** — The remote iloom pushes branches to. In a fork workflow, branches are pushed here, then a cross-fork PR is opened on the `issueManagement` repo.

In fork workflows, issues and PRs live on `upstream` while you push branches to `origin`.

### 5. Update `.gitignore`

Ensure local/personal files are not tracked:

```bash
# Add to .gitignore
echo '.iloom/settings.local.json' >> .gitignore
echo '.vscode/settings.json' >> .gitignore   # Only if colors.vscode is true
```

### 6. Validate the configuration

Run any iloom command to verify settings are loaded:

```bash
il list --json
```

If settings are valid, this returns a JSON array of looms. If there are errors, iloom will report them.

### 7. (Optional) Validate against JSON Schema

The settings JSON schema is bundled at `<iloom-install-path>/dist/schema/settings.schema.json`. You can validate your settings programmatically:

```bash
# Using ajv-cli (npm install -g ajv-cli)
ajv validate -s "$(dirname $(which il))/../dist/schema/settings.schema.json" -d .iloom/settings.json

# Or using node inline
node -e "
const schema = require('$(dirname $(which il))/../dist/schema/settings.schema.json');
const settings = require('./.iloom/settings.json');
// Basic structural check — schema is JSON Schema Draft 7
console.log('Settings loaded:', Object.keys(settings));
"
```

## Settings Reference

### Layering Order (highest to lowest priority)

1. **Local** — `.iloom/settings.local.json` (gitignored, per-machine)
2. **Project** — `.iloom/settings.json` (committed, shared with team)
3. **Global** — `~/.config/iloom-ai/settings.json` (all projects on this machine)

Local overrides project, project overrides global.

### Complete Settings Schema

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mainBranch` | string | auto-detected | Primary branch name (`main`, `master`, etc.) |
| `sourceEnvOnStart` | boolean | `false` | Source dotenv-flow files when launching processes |
| `worktreePrefix` | string | `<repo>-looms` | Prefix for worktree directories (empty string disables) |
| `protectedBranches` | string[] | `[mainBranch, "main", "master", "develop"]` | Branches that cannot be deleted |
| `copyGitIgnoredPatterns` | string[] | `[]` | Glob patterns for gitignored files to copy to looms |

#### `workflows` — Per-workflow-type settings

Each workflow type (`issue`, `pr`, `regular`) supports:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `permissionMode` | enum | `"default"` | `"plan"` \| `"acceptEdits"` \| `"bypassPermissions"` \| `"default"` |
| `noVerify` | boolean | `false` | Skip pre-commit hooks during commit/finish |
| `startIde` | boolean | `true` | Open IDE when starting a loom |
| `startDevServer` | boolean | `true` | Launch dev server on start |
| `startAiAgent` | boolean | `true` | Launch Claude Code on start |
| `startTerminal` | boolean | `false` | Open terminal window on start |
| `generateSummary` | boolean | `true` | Generate session summary on finish |

#### `agents` — Per-agent configuration

Available agents: `iloom-issue-analyzer`, `iloom-issue-planner`, `iloom-issue-analyze-and-plan`, `iloom-issue-complexity-evaluator`, `iloom-issue-enhancer`, `iloom-issue-implementer`, `iloom-code-reviewer`, `iloom-artifact-reviewer`

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | enum | — | `"sonnet"` \| `"opus"` \| `"haiku"` |
| `enabled` | boolean | `true` | Whether this agent is enabled |
| `review` | boolean | `false` | Review artifacts before posting |
| `providers` | object | — | Map of `claude`/`gemini`/`codex` to model name strings |

#### `plan` — Planning command settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | enum | `"opus"` | Claude model for planning |
| `planner` | enum | `"claude"` | AI provider: `"claude"` \| `"gemini"` \| `"codex"` |
| `reviewer` | enum | `"none"` | Review provider: `"claude"` \| `"gemini"` \| `"codex"` \| `"none"` |

#### `spin` — Spin orchestrator settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | enum | `"opus"` | Claude model for spin |

#### `summary` — Session summary settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `model` | enum | `"sonnet"` | Claude model for summaries |

#### `issueManagement` — Issue tracker configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `provider` | enum | `"github"` | `"github"` \| `"linear"` \| `"jira"` |
| `github.remote` | string | — | Git remote name for GitHub operations |
| `linear.teamId` | string | — | Linear team identifier (e.g., `"ENG"`) |
| `linear.apiToken` | string | — | **Local only** — never commit |
| `jira.host` | string | — | Jira instance URL |
| `jira.username` | string | — | Jira username/email |
| `jira.apiToken` | string | — | **Local only** — never commit |
| `jira.projectKey` | string | — | Jira project key (e.g., `"PROJ"`) |

#### `mergeBehavior` — How looms are merged

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mode` | enum | `"local"` | `"local"` \| `"github-pr"` \| `"github-draft-pr"` |
| `remote` | string | — | Git remote for PR creation |
| `autoCommitPush` | boolean | `true` (draft PR) | Auto-commit and push after code review |

#### `ide` — Editor configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `type` | enum | `"vscode"` | `"vscode"` \| `"cursor"` \| `"webstorm"` \| `"sublime"` \| `"intellij"` \| `"windsurf"` \| `"antigravity"` |

#### `colors` — Visual identification

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal` | boolean | `true` | Terminal background colors per branch (macOS only) |
| `vscode` | boolean | `false` | VSCode title bar colors per branch |

#### `attribution`

| Value | Description |
|-------|-------------|
| `"off"` | Never show iloom attribution |
| `"upstreamOnly"` | Only for external/open-source repos (default) |
| `"on"` | Always show attribution |

#### `git` — Git operation settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `commitTimeout` | number | `60000` | Timeout (ms) for git commit operations (1s–600s) |

## Example: Full Configuration

**`.iloom/settings.json`** (committed):
```json
{
  "mainBranch": "main",
  "mergeBehavior": {
    "mode": "github-draft-pr"
  },
  "issueManagement": {
    "provider": "github"
  },
  "colors": {
    "terminal": true,
    "vscode": true
  },
  "agents": {
    "iloom-issue-implementer": { "model": "opus" },
    "iloom-code-reviewer": {
      "providers": { "gemini": "gemini-3-pro-preview" }
    },
    "iloom-artifact-reviewer": {
      "enabled": true,
      "providers": { "gemini": "gemini-3-pro-preview" }
    }
  },
  "attribution": "on"
}
```

**`.iloom/settings.local.json`** (gitignored):
```json
{
  "workflows": {
    "issue": {
      "permissionMode": "bypassPermissions",
      "noVerify": true,
      "startIde": false,
      "startAiAgent": true,
      "startTerminal": false
    }
  }
}
```
