# Core Workflow Commands

## il init

Initialize iloom for a project. This is always the first iloom command to run.

### Prerequisites

1. Project directory must exist with a package manager initialized (`pnpm init`, `npm init`, `cargo init`, etc.)
2. Git repository must be initialized (`git init`) with at least one commit
3. A GitHub remote should be configured (`git remote add origin ...`)

### Usage

```bash
# Interactive setup wizard (foreground only, do NOT use background mode)
bash pty:true command:"il init"

# With a natural language instruction
bash pty:true command:"il init 'set IDE to windsurf'"
```

### Behavior

- Creates `.iloom/` directory with `settings.json` and `settings.local.json`
- Launches Claude Code for guided configuration
- Detects project capabilities (web, CLI, library)
- Configures issue tracker (GitHub, Linear, or Jira)
- Sets merge behavior, IDE preferences, and workflow settings
- Marks the project as configured in `~/.config/iloom-ai/projects/`

### Important

- **Must run in foreground** — this is an interactive wizard
- **Requires PTY** — Claude Code needs a terminal
- Only needs to run once per project

---

## il start

Create an isolated loom workspace for an issue, PR, or branch.

**Aliases:** `new`, `create`, `up`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[identifier]` | positional | — | Issue number, PR number (`pr/123`), branch name, or description text |
| `--one-shot <mode>` | enum | `default` | Automation mode: `default`, `noReview`, `bypassPermissions` |
| `--yolo` | boolean | `false` | Shorthand for `--one-shot=bypassPermissions` |
| `--claude` / `--no-claude` | boolean | `true` | Enable/disable Claude integration |
| `--code` / `--no-code` | boolean | `true` | Enable/disable VS Code opening |
| `--dev-server` / `--no-dev-server` | boolean | `true` | Enable/disable dev server |
| `--terminal` / `--no-terminal` | boolean | `false` | Enable/disable terminal tab |
| `--child-loom` / `--no-child-loom` | boolean | — | Force child/independent loom (skips prompt) |
| `--body <text>` | string | — | Issue body text (skips AI enhancement) |
| `--json` | boolean | `false` | Output result as JSON |

### Examples

```bash
# Start a loom for issue #42 in autonomous mode, no VS Code, JSON output
bash pty:true background:true command:"il start 42 --yolo --no-code --json"

# Start a loom for a PR
bash pty:true background:true command:"il start pr/99 --yolo --no-code --json"

# Create a loom from a description (auto-creates GitHub issue)
bash pty:true background:true command:"il start 'Add dark mode support to the settings page' --yolo --no-code --json"

# Force independent loom (skip child loom prompt)
bash pty:true background:true command:"il start 42 --yolo --no-code --no-child-loom --json"
```

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses and execution mode guidance.

### JSON Output

```json
{
  "id": "string",
  "path": "/path/to/worktree",
  "branch": "feat/42-feature-name",
  "port": 3042,
  "type": "issue",
  "identifier": 42,
  "title": "Feature name"
}
```

---

## il finish

Validate, commit, merge, and clean up a loom workspace.

**Aliases:** `dn`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[identifier]` | positional | — | Auto-detected from current directory if omitted |
| `-f, --force` | boolean | `false` | Skip confirmation prompts |
| `-n, --dry-run` | boolean | `false` | Preview actions without executing |
| `--pr <number>` | number | — | Treat input as PR number |
| `--skip-build` | boolean | `false` | Skip post-merge build verification |
| `--no-browser` | boolean | `false` | Skip opening PR in browser |
| `--cleanup` / `--no-cleanup` | boolean | — | Explicit cleanup decision (skips prompt) |
| `--json` | boolean | `false` | Output result as JSON |
| `--json-stream` | boolean | `false` | Stream JSONL progress output |

### Examples

```bash
# Fully autonomous finish from within a loom directory (background recommended — can take 1-2+ min)
bash pty:true background:true command:"il finish --force --cleanup --no-browser --json-stream"

# Dry run to preview what would happen
bash pty:true command:"il finish --dry-run"

# Finish a specific issue
bash pty:true background:true command:"il finish 42 --force --cleanup --no-browser --json-stream"
```

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses and execution mode guidance.

### JSON Output

```json
{
  "success": true,
  "type": "issue",
  "identifier": 42,
  "operations": [
    { "type": "validation", "message": "...", "success": true },
    { "type": "commit", "message": "...", "success": true },
    { "type": "merge", "message": "...", "success": true }
  ],
  "prUrl": "https://github.com/owner/repo/pull/99",
  "cleanupResult": { ... }
}
```

---

## il cleanup

Remove one or more loom workspaces without merging.

**Aliases:** `remove`, `clean`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[identifier]` | positional | — | Branch name or work item identifier |
| `-l, --list` | boolean | `false` | List all worktrees (informational) |
| `-a, --all` | boolean | `false` | Remove all worktrees |
| `-i, --issue <number>` | number | — | Cleanup by issue number |
| `-f, --force` | boolean | `false` | Skip confirmations and force removal |
| `--dry-run` | boolean | `false` | Show what would be done |
| `--json` | boolean | `false` | Output result as JSON |
| `--defer <ms>` | number | — | Wait before cleanup (milliseconds) |

### Examples

```bash
# Remove a specific loom by issue number
bash pty:true command:"il cleanup --issue 42 --force --json"

# Remove all looms
bash pty:true command:"il cleanup --all --force --json"

# List worktrees without removing
bash pty:true command:"il cleanup --list"

# Dry run
bash pty:true command:"il cleanup --issue 42 --dry-run"
```

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses.

### JSON Output

```json
{
  "identifier": "42",
  "success": true,
  "dryRun": false,
  "operations": [
    { "type": "worktree", "success": true, "message": "...", "deleted": true },
    { "type": "branch", "success": true, "message": "...", "deleted": true }
  ],
  "errors": [],
  "rollbackRequired": false
}
```

---

## il list

Display active loom workspaces.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | boolean | `false` | Output as JSON array |
| `--finished` | boolean | `false` | Show only finished looms |
| `--all` | boolean | `false` | Show both active and finished looms |
| `--global` | boolean | `false` | Show looms from all projects |
| `--children` | boolean | `false` | Include child issues and child looms |

### Examples

```bash
# List active looms as JSON
bash pty:true command:"il list --json"

# List all looms (active + finished)
bash pty:true command:"il list --all --json"

# List looms across all projects
bash pty:true command:"il list --global --json"
```

### No Interactive Prompts

This is a read-only command with no interactive prompts.

### JSON Output

Returns an array of loom objects:

```json
[
  {
    "name": "feat/42-dark-mode",
    "worktreePath": "/path/to/worktree",
    "branch": "feat/42-dark-mode",
    "type": "issue",
    "issue_numbers": [42],
    "isMainWorktree": false,
    "status": "active",
    "isChildLoom": false
  }
]
```
