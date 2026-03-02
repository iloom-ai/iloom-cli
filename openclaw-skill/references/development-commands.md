# Development Commands

Commands for working within an active loom workspace.

## il spin

Launch Claude CLI with auto-detected loom context.

**Aliases:** `ignite`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--one-shot <mode>` | enum | `default` | Automation mode: `default`, `noReview`, `bypassPermissions` |
| `--yolo` | boolean | `false` | Shorthand for `--one-shot=bypassPermissions` |
| `-p, --print` | boolean | `false` | Headless mode for CI/CD (implies `bypassPermissions`) |
| `--output-format <format>` | enum | — | Output format: `json`, `stream-json`, `text` (requires `--print`) |
| `--verbose` | boolean | — | Verbose output (requires `--print`) |
| `--json` | boolean | `false` | Final result as JSON (requires `--print`) |
| `--json-stream` | boolean | `false` | Stream JSONL output (requires `--print`) |

### Examples

```bash
# Launch Claude in background with autonomous mode
bash pty:true background:true command:"il spin --yolo"

# Headless mode with JSON output
bash pty:true command:"il spin --yolo --print --output-format json"

# Monitor background session
process action:log sessionId:XXX
process action:poll sessionId:XXX
```

See `{baseDir}/references/non-interactive-patterns.md` for execution mode guidance.

---

## il commit

Commit all uncommitted files with issue reference trailer.

**Aliases:** `c`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-m, --message <text>` | string | — | Custom commit message (skips Claude generation) |
| `--fixes` | boolean | `false` | Use "Fixes #N" trailer instead of "Refs #N" |
| `--no-review` | boolean | `false` | Skip commit message review prompt |
| `--json` | boolean | `false` | Output result as JSON (implies `--no-review`) |
| `--json-stream` | boolean | `false` | Stream JSONL progress output |
| `--wip-commit` | boolean | `false` | Quick WIP commit: skip validations and pre-commit hooks |

### Examples

```bash
# Non-interactive commit with AI-generated message (background recommended — Claude generates message)
bash pty:true background:true command:"il commit --no-review --json-stream"

# Commit with custom message
bash pty:true command:"il commit -m 'fix: resolve auth timeout' --json"

# Quick WIP commit (skips hooks and validation)
bash pty:true command:"il commit --wip-commit --json"

# Commit that closes the issue
bash pty:true command:"il commit --fixes --no-review --json"
```

See `{baseDir}/references/non-interactive-patterns.md` for prompt bypasses and execution mode guidance.

### JSON Output

```json
{
  "success": true,
  "commitHash": "abc1234",
  "message": "fix: resolve auth timeout\n\nRefs #42",
  "filesChanged": 3,
  "issueNumber": 42,
  "trailerType": "Refs"
}
```

---

## il rebase

Rebase current loom branch on main with AI-assisted conflict resolution.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-f, --force` | boolean | `false` | Force rebase even in edge cases |
| `-n, --dry-run` | boolean | `false` | Simulate rebase without changes |
| `--json-stream` | boolean | `false` | Stream JSONL progress output |

### Examples

```bash
# Rebase with force and progress streaming (background recommended — Claude may resolve conflicts)
bash pty:true background:true command:"il rebase --force --json-stream"

# Dry run
bash pty:true command:"il rebase --dry-run"
```

### Behavior

- Detects uncommitted changes and throws if found (commit first)
- Claude assists with conflict resolution if conflicts arise
- Post-rebase: installs dependencies and runs build (non-blocking)
- Use `--json-stream` for incremental progress visibility

---

## il build

Run the build script for the current workspace.

```bash
bash pty:true command:"il build"
```

No flags. Runs in foreground. No JSON output.

---

## il test

Run the test script for the current workspace.

```bash
bash pty:true command:"il test"
```

No flags. Runs in foreground. No JSON output.

---

## il lint

Run the lint script for the current workspace.

```bash
bash pty:true command:"il lint"
```

No flags. Runs in foreground. No JSON output.

---

## il compile

Run the TypeScript compiler check for the current workspace.

**Aliases:** `typecheck`

```bash
bash pty:true command:"il compile"
```

No flags. Runs in foreground. No JSON output.

---

## il dev-server

Start the development server for a workspace.

**Aliases:** `dev`

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[identifier]` | positional | — | Work item identifier, PR number, or branch name (auto-detected) |
| `--json` | boolean | `false` | Output result as JSON |

### Examples

```bash
# Start dev server (auto-detect workspace)
bash pty:true command:"il dev-server --json"

# Start dev server for specific issue
bash pty:true command:"il dev-server 42 --json"
```

### JSON Output

```json
{
  "status": "started",
  "url": "http://localhost:3042",
  "port": 3042,
  "pid": 12345,
  "message": "Dev server started"
}
```

Port is calculated as `basePort + issue/PR number` (default base: 3000).

---

## il shell

Open an interactive shell with workspace environment variables loaded.

**Aliases:** `terminal`

```bash
bash pty:true command:"il shell"
```

No flags. Opens a subshell with the loom's `.env` variables injected.

---

## il open

Open the loom in browser (web projects) or run the configured CLI tool.

**Aliases:** `run`

```bash
bash pty:true command:"il open"
bash pty:true command:"il open 42"
```

Accepts an optional `[identifier]` positional argument.

---

## il vscode

Open the workspace in VS Code and install the iloom extension.

```bash
bash pty:true command:"il vscode"
bash pty:true command:"il vscode --no-wait"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--no-wait` | boolean | `false` | Don't wait for VS Code to close |

---

## il summary

Generate a Claude session summary for a loom.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `[identifier]` | positional | — | Work item identifier (auto-detected from any tracker) |
| `--with-comment` | boolean | `false` | Post summary as comment to issue/PR |
| `--json` | boolean | `false` | Output result as JSON |

### Examples

```bash
# Generate summary for current loom
bash pty:true command:"il summary --json"

# Generate and post as comment
bash pty:true command:"il summary --with-comment --json"
```

### JSON Output

```json
{
  "summary": "## Session Summary\n...",
  "sessionId": "uuid",
  "branchName": "feat/42-feature",
  "loomType": "issue",
  "issueNumber": 42
}
```

---

## il recap

Get the recap (decisions, insights, risks, assumptions) for a loom.

```bash
bash pty:true command:"il recap --json"
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | boolean | `false` | Output result as JSON |
