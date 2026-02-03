# iloom Command Reference

Complete documentation for all iloom CLI commands, options, and flags.

## Table of Contents

- [Core Workflow Commands](#core-workflow-commands)
  - [il start](#il-start)
  - [il commit](#il-commit)
  - [il finish](#il-finish)
  - [il rebase](#il-rebase)
  - [il cleanup](#il-cleanup)
  - [il list](#il-list)
- [Context & Development Commands](#context--development-commands)
  - [il spin](#il-spin)
  - [il open](#il-open)
  - [il vscode](#il-vscode)
  - [il dev-server](#il-dev-server)
  - [il build](#il-build)
  - [il lint](#il-lint)
  - [il test](#il-test)
  - [il compile](#il-compile)
  - [il summary](#il-summary)
  - [il shell](#il-shell)
- [Planning Commands](#planning-commands)
  - [il plan](#il-plan)
- [Issue Management Commands](#issue-management-commands)
  - [il add-issue](#il-add-issue)
  - [il enhance](#il-enhance)
- [Configuration & Maintenance](#configuration--maintenance)
  - [il init / il config](#il-init--il-config)
  - [il update](#il-update)
  - [il feedback](#il-feedback)
  - [il contribute](#il-contribute)

---

## Core Workflow Commands

### il start

Create an isolated loom workspace with complete AI-assisted context establishment.

**Aliases:** `new`, `create`, `up`

**Usage:**
```bash
il start <issue-number>
il start <pr-number>
il start <branch-name>
il start "<issue-description>"
```

**Arguments:**
- `<issue-number>` - GitHub or Linear issue number (e.g., `25`)
- `<pr-number>` - GitHub pull request number (e.g., `42`)
- `<branch-name>` - Existing git branch name
- `<issue-description>` - Free-form description to create a new issue (quoted string)

**Options:**

| Flag | Values | Description |
|------|--------|-------------|
| `--one-shot` | `default`, `noReview`, `bypassPermissions` | Automation level for Claude CLI workflow |
| `--yolo` | - | Shorthand for `--one-shot=bypassPermissions` (autonomous mode) |
| `--child-loom` | - | Force create as child loom (skip prompt, requires parent loom) |
| `--no-child-loom` | - | Force create as independent loom (skip prompt) |
| `--claude` / `--no-claude` | - | Enable/disable Claude integration (default: enabled) |
| `--code` / `--no-code` | - | Enable/disable VS Code launch (default: enabled) |
| `--dev-server` / `--no-dev-server` | - | Enable/disable dev server in terminal (default: enabled) |
| `--terminal` / `--no-terminal` | - | Enable/disable terminal without dev server (default: disabled) |
| `--body` | `<text>` | Body text for issue (skips AI enhancement) |

**One-Shot Modes:**
- `default` - Standard behavior with approval prompts at each phase
- `noReview` - Skip phase approval prompts, but respect permission settings
- `bypassPermissions` - Full automation, skip all permission and approval prompts (use with caution!)

**Workflow Phases:**

The `il start` command orchestrates multiple AI agents:

1. **Fetch** - Retrieves issue/PR details from GitHub or Linear
2. **Enhance** (conditional) - Expands brief issues into detailed requirements
3. **Evaluate** - Assesses complexity and determines workflow approach (Simple vs Complex)
4. **Analyze** (complex issues only) - Investigates root causes and technical constraints
5. **Plan** - Creates implementation roadmap
   - Complex issues: Detailed dedicated planning phase
   - Simple issues: Combined analysis + planning in one step
6. **Environment Setup** - Creates worktree, database branch, environment variables
7. **Launch** - Opens IDE with color theme and starts development server

**Examples:**

```bash
# Start work on GitHub issue #25
il start 25

# Start work on Linear issue ILM-42
il start ILM-42

# Create a new issue and start work
il start "Add dark mode toggle to settings"

# Start with full automation (skip all prompts)
il start 25 --one-shot=bypassPermissions

# Start with full automation using shorthand
il start 25 --yolo

# Force create as child loom when working inside another loom
il start 42 --child-loom

# Create independent loom even when inside another loom
il start 99 --no-child-loom
```

**Notes:**
- When run from inside an existing loom, prompts to create a child loom (unless flags override)
- Creates isolated environment: Git worktree, database branch, unique port
- All AI analysis is posted as issue comments for team visibility
- Color codes the VS Code window for visual context switching

---

### il commit

Commit all uncommitted files with an issue reference trailer.

**Alias:** `c`

**Usage:**
```bash
il commit [options]
```

**Must be run from within a loom directory.**

**Options:**

| Flag | Description |
|------|-------------|
| `-m`, `--message <text>` | Custom commit message (skips Claude generation) |
| `--fixes` | Use "Fixes #N" trailer instead of "Refs #N" (closes the issue) |
| `--no-review` | Skip commit message review prompt |
| `--json` | Output result as JSON (implies `--no-review`) |

**Behavior:**

1. Auto-detects issue number from current worktree path
2. Stages all uncommitted files (`git add -A`)
3. Generates commit message using Claude (or uses `-m` message if provided)
4. Appends issue reference trailer:
   - Default: `Refs #N` (references issue without closing)
   - With `--fixes`: `Fixes #N` (closes the issue when merged)
5. Prompts for review (unless `--no-review` or `--json`)
6. Commits with the generated message

**Trailer Behavior:**

| Trailer | Effect | When to Use |
|---------|--------|-------------|
| `Refs #N` | References issue, keeps it open | Work-in-progress commits during development |
| `Fixes #N` | Closes issue when commit is merged to default branch | Final commit that completes the issue |

**Examples:**

```bash
# Basic usage (auto-detect issue, Refs trailer)
il commit

# With custom message
il commit -m "Add authentication service"

# Mark this commit as fixing the issue
il commit --fixes

# Skip review prompt
il commit --no-review

# JSON output for scripting (implies --no-review)
il commit --json

# Combine flags
il commit -m "Final implementation" --fixes --no-review
```

**Example Commit Messages:**

With Claude generation:
```
Add user authentication endpoints

- Implement login endpoint with JWT tokens
- Add password hashing with bcrypt
- Create user registration flow

Refs #425
```

With `--fixes` flag:
```
Add user authentication endpoints

- Implement login endpoint with JWT tokens
- Add password hashing with bcrypt
- Create user registration flow

Fixes #425
```

**JSON Output Format:**
```json
{
  "success": true,
  "commitHash": "a1b2c3d",
  "message": "Add user authentication endpoints...",
  "filesChanged": 5,
  "issueNumber": "425",
  "trailerType": "Refs"
}
```

**Notes:**
- Use `il commit` for intermediate commits during development
- Use `il commit --fixes` or `il finish` when completing the issue
- The `--json` flag is useful for CI/CD pipelines and scripting
- If not in an issue/PR worktree, `--fixes` prints a warning and is ignored

---

### il finish

Validate, commit, merge, and cleanup a loom workspace with AI-assisted error resolution.

**Alias:** `dn`

**Usage:**
```bash
il finish [options]
```

**Must be run from within a loom directory.**

**Options:**

| Flag | Description |
|------|-------------|
| `-f`, `--force` | Skip confirmation prompts |
| `-n`, `--dry-run` | Preview actions without executing |
| `--pr` | Treat input as PR number |
| `--skip-build` | Skip post-merge build verification |
| `--no-browser` | Skip opening PR in browser (github-pr mode only) |
| `--cleanup` | Clean up worktree after finishing (default in local mode) |
| `--no-cleanup` | Keep worktree after finishing (default in github-pr and github-draft-pr modes)|

**Merge Behavior Modes:**

Behavior depends on the `mergeBehavior.mode` setting in your iloom configuration:

**`local` (default):**
1. Detects uncommitted changes and auto-commits
2. Runs validation pipeline: typecheck, lint, tests
3. If failures occur, launches Claude to help fix issues
4. Rebases on main branch
5. Validates fast-forward merge is possible
6. Merges to main
7. Installs dependencies in main
8. Runs post-merge build verification
9. Cleans up worktree and database branch

**`github-pr`:**
1. Same validation pipeline as local mode
2. Pushes branch to remote
3. Creates GitHub pull request
4. Opens PR in browser (unless `--no-browser`)
5. Prompts for cleanup (or use `--cleanup`/`--no-cleanup` flags)

**Examples:**

```bash
# Standard finish workflow
il finish

# Preview what will happen without executing
il finish --dry-run

# Finish and skip confirmation prompts
il finish --force

# Create PR and keep worktree for additional changes
il finish --no-cleanup

# Create PR without opening browser
il finish --no-browser
```

**Migration Conflict Handling:**

For Payload CMS projects, iloom automatically detects and handles migration conflicts:
- Identifies migration file conflicts
- Launches Claude to help resolve discrepancies
- Validates schema consistency

**Notes:**
- Claude assists with fixing any test, typecheck, or lint failures
- Automatically generates commit message from issue context
- Handles merge conflicts with AI assistance
- Cleans up all resources: worktree, database branch, dev server

---

### il rebase

Rebase current loom branch on the main branch with AI-assisted conflict resolution.

**Usage:**
```bash
il rebase [options]
```

**Must be run from within a loom directory.**

**Options:**

| Flag | Description |
|------|-------------|
| `-f`, `--force` | Skip confirmation prompts |
| `-n`, `--dry-run` | Preview actions without executing |

**Workflow:**

1. Fetches latest changes from main branch
2. Attempts to rebase current branch
3. If conflicts occur, launches Claude to help resolve
4. Validates resolution and completes rebase

**Examples:**

```bash
# Rebase with confirmation prompt
il rebase

# Rebase and skip confirmation
il rebase --force

# Preview rebase without executing
il rebase --dry-run
```

**Notes:**
- Useful when main branch has advanced and you need to sync
- Claude provides context-aware conflict resolution assistance
- Safe to run multiple times

---

### il cleanup

Remove one or more loom workspaces without merging.

**Aliases:** `remove`, `clean`

**Usage:**
```bash
il cleanup [options] [identifier]
```

**Arguments:**
- `[identifier]` - Branch name or issue number to cleanup (auto-detected if omitted)

**Options:**

| Flag | Description |
|------|-------------|
| `-l`, `--list` | List all worktrees |
| `-a`, `--all` | Remove all worktrees (interactive confirmation) |
| `-i`, `--issue` | Cleanup by issue number |
| `-f`, `--force` | Skip confirmations and force removal |
| `--dry-run` | Show what would be done without doing it |

**Workflow:**

1. Identifies matching loom(s)
2. Confirms deletion (unless forced)
3. Removes Git worktree
4. Deletes database branch (if configured)
5. Removes loom directory

**Examples:**

```bash
# Cleanup specific loom by issue number
il cleanup 25

# Cleanup by issue number explicitly
il cleanup -i 25

# List all worktrees
il cleanup --list

# Preview cleanup without executing
il cleanup 25 --dry-run

# Remove all worktrees (interactive)
il cleanup --all

# Force cleanup without confirmation
il cleanup 25 --force
```

**Safety:**
- Checks for uncommitted changes and warns
- Cannot cleanup currently active loom
- Database branches are safely deleted

---

### il list

Display all active loom workspaces with their details.

**Usage:**
```bash
il list [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON |
| `--finished` | Show only finished looms |
| `--all` | Show both active and finished looms |

**Output includes:**
- Issue/PR number and title
- Branch name
- Loom directory path
- Development server port (for web projects)
- CLI binary name (for CLI projects)
- Database branch name (if configured)
- Current status (active, has uncommitted changes, etc.)
- Finish time (for finished looms with `--finished` or `--all`)

**Examples:**

```bash
# List all active looms (default)
il list

# List only finished looms
il list --finished

# List both active and finished looms
il list --all

# Output as JSON
il list --json

# Output example:
# Active Looms:
# ──────────────────────────────────────────────────────
#  #25  feat-add-dark-mode
#       ~/my-project-looms/feat-issue-25-dark-mode/
#       Port: 3025 | DB: br-issue-25
#
#  #42  fix-authentication-bug
#       ~/my-project-looms/fix-issue-42-auth/
#       Port: 3042 | DB: br-issue-42
```

---

## Context & Development Commands

### il spin

Launch Claude CLI with auto-detected loom context.

**Usage:**
```bash
il spin [options]
```

**Options:**

| Flag | Values | Description |
|------|--------|-------------|
| `--one-shot` | `noReview`, `bypassPermissions` | Automation level (same as `il start`) |
| `--yolo` | - | Shorthand for `--one-shot=bypassPermissions` (autonomous mode) |

**Behavior:**

- **Inside a loom:** Launches Claude with that loom's context preloaded
- **Outside a loom:** Launches Claude with general project context

**Context Loading:**

When launched from inside a loom, Claude receives:
- Issue/PR description and all comments
- AI-generated enhancement, analysis, and planning
- Current file tree and recent changes
- Environment details (port, database branch, etc.)

**Examples:**

```bash
# Launch Claude with current loom context
il spin

# Launch with full automation
il spin --one-shot=bypassPermissions

# Launch with full automation using shorthand
il spin --yolo
```

---

### il open

Open loom in browser (web projects) or run configured CLI tool (CLI projects).

**Alias:** `run`

**Usage:**
```bash
il open [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number or loom identifier
- If omitted and inside a loom, opens current loom
- If omitted outside a loom, prompts for selection

**Behavior by Project Type:**

**Web Projects:**
- Opens development server in default browser
- Uses the loom's unique port (e.g., http://localhost:3025)

**CLI Projects:**
- Runs the loom-specific binary
- Executes with any additional arguments passed

**Examples:**

```bash
# Open current loom
il open

# Open specific loom by issue number
il open 25

# For CLI projects, run with arguments
il open 25 --help
il open 25 --version
```

---

### il vscode

Install the iloom VS Code extension and open a workspace in VS Code.

**Usage:**
```bash
il vscode [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted, auto-detects from current directory or branch

**Behavior:**

1. Checks if VS Code CLI (`code`) is available
2. Parses identifier or auto-detects from current directory/branch
3. Finds the corresponding worktree
4. Installs the iloom VS Code extension (if not already installed)
5. Opens VS Code at the worktree path

**Examples:**

```bash
# Auto-detect from current directory
il vscode

# Open workspace for issue #45
il vscode 45

# Open workspace for Linear issue
il vscode ENG-123

# Open workspace for branch
il vscode feat/my-feature
```

**Notes:**
- Requires VS Code CLI (`code`) to be available in PATH
- Automatically installs the iloom VS Code extension if not present
- Works with any loom workspace (issue, PR, or branch-based)

---

### il dev-server

Start development server in foreground for a workspace.

**Alias:** `dev`

**Usage:**
```bash
il dev-server [identifier] [options]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted and inside a loom, starts dev server for current loom
- If omitted outside a loom, prompts for selection

**Behavior:**

1. Resolves the target loom
2. Loads environment variables from `.env` files
3. Executes dev script from `package.json` or `.iloom/package.iloom.json`
4. Runs in foreground (useful for debugging and manual testing)

**Examples:**

```bash
# Start dev server for current loom
il dev-server

# Start dev server for specific issue
il dev-server 25

# Start dev server for a branch
il dev-server feat/my-branch
```

**Notes:**
- Runs in foreground to see server output and errors
- Use Ctrl+C to stop the server
- Respects `sourceEnvOnStart` setting for environment loading

---

### il build

Run the build script for a workspace.

**Usage:**
```bash
il build [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted and inside a loom, builds current loom
- If omitted outside a loom, prompts for selection

**Behavior:**

1. Resolves the target loom or current workspace
2. Loads environment variables from `.env` files
3. Executes build script from:
   - `.iloom/package.iloom.json` (highest priority)
   - `package.json` (fallback for Node.js projects)
4. Exits with non-zero code if build fails

**Script Resolution:**

Scripts are resolved in this order:
1. `scripts.build` in `.iloom/package.iloom.json` (if exists)
2. `scripts.build` in `package.json` (if exists)

**Examples:**

```bash
# Build current loom (auto-detected)
il build

# Build specific issue
il build 25

# Run in specific loom workspace
cd ~/my-project-looms/feat-issue-42-feature/
il build
```

**Supported Projects:**

| Language | Build Command | Configuration source |
|----------|---------------|---------------|
| Node.js (npm) | `npm run build` | `package.json` scripts |
| Node.js (pnpm) | `pnpm build` | `package.json` scripts |
| Node.js (yarn) | `yarn build` | `package.json` scripts |
| Rust | `cargo build --release` | `.iloom/package.iloom.json` |
| Python (pip) | `pip install -e .` | `.iloom/package.iloom.json` |
| Python (poetry) | `poetry install` | `.iloom/package.iloom.json` |
| Ruby | `bundle install` | `.iloom/package.iloom.json` |
| Go | `go build ./...` | `.iloom/package.iloom.json` |

**Notes:**
- Works with any language/framework via `.iloom/package.iloom.json`
- Environment variables are automatically loaded before execution
- Build failures are reported with exit codes for CI/CD integration

---

### il lint

Run the lint script for a workspace.

**Usage:**
```bash
il lint [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted and inside a loom, lints current loom
- If omitted outside a loom, prompts for selection

**Behavior:**

1. Resolves the target loom or current workspace
2. Loads environment variables from `.env` files
3. Executes lint script from:
   - `.iloom/package.iloom.json` (highest priority)
   - `package.json` (fallback for Node.js projects)
4. Exits with non-zero code if linting fails

**Script Resolution:**

Scripts are resolved in this order:
1. `scripts.lint` in `.iloom/package.iloom.json` (if exists)
2. `scripts.lint` in `package.json` (if exists)

**Examples:**

```bash
# Lint current loom (auto-detected)
il lint

# Lint specific issue
il lint 25

# Validate code style in feature branch
il lint feat/my-feature
```

**Supported Linters:**

| Language | Typical Command | Configuration source |
|----------|-----------------|---------------|
| JavaScript/TypeScript | `eslint .` | `.iloom/package.iloom.json` or `package.json` |
| Python | `pylint src/` | `.iloom/package.iloom.json` |
| Rust | `cargo clippy` | `.iloom/package.iloom.json` |
| Ruby | `rubocop` | `.iloom/package.iloom.json` |
| Go | `golangci-lint run` | `.iloom/package.iloom.json` |

**Notes:**
- Works with any linter via `.iloom/package.iloom.json`
- Environment variables are automatically loaded before execution
- Lint failures are reported with exit codes for CI/CD integration

---

### il test

Run the test script for a workspace.

**Usage:**
```bash
il test [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted and inside a loom, tests current loom
- If omitted outside a loom, prompts for selection

**Behavior:**

1. Resolves the target loom or current workspace
2. Loads environment variables from `.env` files
3. Executes test script from:
   - `.iloom/package.iloom.json` (highest priority)
   - `package.json` (fallback for Node.js projects)
4. Exits with non-zero code if tests fail

**Script Resolution:**

Scripts are resolved in this order:
1. `scripts.test` in `.iloom/package.iloom.json` (if exists)
2. `scripts.test` in `package.json` (if exists)

**Examples:**

```bash
# Run tests for current loom (auto-detected)
il test

# Run tests for specific issue
il test 25

# Test feature branch
il test feat/my-feature
```

**Supported Test Frameworks:**

| Language | Typical Command | Configuration |
|----------|-----------------|---------------|
| JavaScript/TypeScript | `vitest run` or `jest` | `.iloom/package.iloom.json` or `package.json` |
| Python | `pytest` | `.iloom/package.iloom.json` |
| Rust | `cargo test` | `.iloom/package.iloom.json` |
| Ruby | `bundle exec rspec` | `.iloom/package.iloom.json` |
| Go | `go test ./...` | `.iloom/package.iloom.json` |

**Notes:**
- Works with any test framework via `.iloom/package.iloom.json`
- Environment variables are automatically loaded before execution
- Test failures are reported with exit codes for CI/CD integration

---

### il compile

Run the compile or typecheck script for a workspace.

**Alias:** `typecheck`

**Usage:**
```bash
il compile [identifier]
il typecheck [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted and inside a loom, compiles current loom
- If omitted outside a loom, prompts for selection

**Behavior:**

1. Resolves the target loom or current workspace
2. Loads environment variables from `.env` files
3. Executes compile/typecheck script from:
   - `.iloom/package.iloom.json` (highest priority)
   - `package.json` (fallback for Node.js projects)
4. Exits with non-zero code if compilation/typecheck fails

**Script Resolution:**

Scripts are resolved in this order:
1. `scripts.compile` in `.iloom/package.iloom.json` (if exists)
2. `scripts.typecheck` in `.iloom/package.iloom.json` (if exists)
3. `scripts.compile` in `package.json` (if exists)
4. `scripts.typecheck` in `package.json` (if exists)

**Examples:**

```bash
# Typecheck current loom (auto-detected)
il compile

# Or using the typecheck alias
il typecheck

# Typecheck specific issue
il compile 25

# Validate types in feature branch
il typecheck feat/my-feature
```

**Supported Languages:**

| Language | Typical Command | Configuration |
|----------|-----------------|---------------|
| TypeScript | `tsc --noEmit` | `.iloom/package.iloom.json` or `package.json` |
| Python | `mypy src/` | `.iloom/package.iloom.json` |
| Rust | `cargo check` | `.iloom/package.iloom.json` |
| Go | `go build ./...` (no-op compile) | `.iloom/package.iloom.json` |

**Notes:**
- Works with any compiler/type checker via `.iloom/package.iloom.json`
- Useful for catching type errors without running full test suite
- Environment variables are automatically loaded before execution
- Compilation failures are reported with exit codes for CI/CD integration

---

### il summary

Generate a summary of the Claude Code session for the current or specified loom.

**Usage:**
```bash
il summary [identifier] [options]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted, auto-detects current loom from working directory

**Options:**

| Flag | Description |
|------|-------------|
| `--with-comment` | Post the summary as a comment to the issue/PR |
| `--json` | Output as JSON (for programmatic use) |

**Behavior:**

1. Auto-detects loom if no identifier provided
2. Generates deterministic session ID if not in metadata
3. Invokes Claude to reflect on the session and generate insights
4. Prints summary to stdout (or outputs JSON with `--json`)
5. Optionally posts as issue comment with `--with-comment`

**Output includes:**
- Key themes from the development session
- Insights and learnings
- Decisions made and rationale
- Challenges resolved
- Lessons learned

**Examples:**

```bash
# Generate summary for current loom
il summary

# Generate summary for specific issue
il summary 25

# Generate and post as comment to issue
il summary --with-comment

# Output as JSON for scripting
il summary --json

# Combine: specific issue, post comment, JSON output
il summary 42 --with-comment --json
```

**JSON Output Format:**
```json
{
  "success": true,
  "summary": "## iloom Session Summary\n...",
  "sessionId": "abc-123-def",
  "issueNumber": "42",
  "branchName": "feat/issue-42-feature",
  "loomType": "issue"
}
```

**Notes:**
- For branch-type looms, `--with-comment` is silently ignored (no issue to post to)
- Summary generation uses the Claude haiku model for speed
- Session summaries are also auto-generated during `il finish` (configurable via `generateSummary` setting)

---

### il shell

Open an interactive shell with workspace environment variables loaded.

**Alias:** `terminal`

**Usage:**
```bash
il shell [identifier]
```

**Arguments:**
- `[identifier]` - Optional issue number, PR number, or branch name
- If omitted, auto-detects current loom from working directory

**Behavior:**

1. Resolves the target loom (from identifier or current directory)
2. Detects appropriate shell for your platform
3. If `sourceEnvOnStart` is enabled in settings, loads all dotenv-flow environment variables
4. Opens interactive shell with environment ready
5. Prints summary of workspace and loaded environment

**Shell Detection (Cross-Platform):**

The shell is selected in this order:
1. `ILOOM_SHELL` environment variable (if set)
2. `SHELL` environment variable (Unix/macOS)
3. `COMSPEC` environment variable (Windows)
4. Default: `/bin/bash` (Unix) or `cmd.exe` (Windows)

**Environment Variables Loaded:**

When `sourceEnvOnStart` is enabled, loads dotenv-flow pattern files:
- `.env`
- `.env.local`
- `.env.{NODE_ENV}`
- `.env.{NODE_ENV}.local`

Additionally sets:
- `ILOOM_LOOM` - The loom identifier (useful for PS1 customization)

**Examples:**

```bash
# Open shell for current loom (auto-detected from cwd)
il shell

# Open shell for specific issue
il shell 25

# Open shell for specific PR
il shell 42

# Open shell for branch-based loom
il shell feat/my-feature

# Using the terminal alias
il terminal 25
```

**Notes:**
- Useful for running ad-hoc commands with proper environment
- Great for debugging or using tools not covered by `il dev-server`
- Environment persists for the entire shell session
- Exit shell normally (Ctrl+D or `exit`) to return

---

## Planning Commands

### il plan

Launch an interactive planning session with an Architect persona to decompose features into child issues.

**Usage:**
```bash
il plan [prompt] [options]
il plan <issue-number> [options]
```

**Arguments:**
- `[prompt]` - Optional initial planning prompt or topic for fresh planning mode
- `<issue-number>` - Issue identifier to decompose (GitHub: `#123` or `123`, Linear: `ENG-123`)

**Operating Modes:**

| Mode | Trigger | Description |
|------|---------|-------------|
| Fresh Planning | `il plan` or `il plan "topic"` | Start a new planning session for a feature or epic |
| Decomposition | `il plan 123` or `il plan #123` | Break down an existing issue into child issues |

**Options:**

| Flag | Values | Description |
|------|--------|-------------|
| `--model <model>` | `opus`, `sonnet`, `haiku` | Model to use (default: from settings `plan.model`, falls back to 'opus') |
| `--yolo` | - | Autonomous mode: skip permission prompts and proceed automatically |
| `--planner <provider>` | `claude`, `gemini`, `codex` | AI provider for planning (default: from settings `plan.planner`, falls back to 'claude') |
| `--reviewer <provider>` | `claude`, `gemini`, `codex`, `none` | AI provider for plan review (default: from settings `plan.reviewer`, falls back to 'none') |

**Behavior:**

1. Loads settings to detect issue provider (GitHub/Linear) and model preference
2. If an issue identifier is provided, fetches issue details, existing children, and dependencies
3. Launches Claude with Architect persona
4. Architect helps decompose features using brainstorming patterns
5. At session end, creates parent epic issue if none provided, and child issues with dependencies

**Fresh Planning Mode:**

Start a new planning session from scratch:

```bash
# Interactive session - Claude asks what you want to plan
il plan

# Provide a topic upfront
il plan "Build user authentication system"
```

**Decomposition Mode:**

Break down an existing issue into child issues:

```bash
# GitHub issue
il plan 42
il plan "#42"

# Linear issue
il plan ENG-123
```

In decomposition mode, the Architect:
- Fetches the parent issue's title, body, and existing comments
- Retrieves any existing child issues and dependencies
- Helps you identify additional sub-tasks
- Creates child issues with proper parent-child relationships

**Multi-AI Provider Support:**

Configure different AI providers for planning and review phases:

```bash
# Use Gemini for planning with Claude review
il plan --planner gemini --reviewer claude "Add OAuth support"

# Use Claude for planning with no review
il plan --planner claude --reviewer none "Fix login flow"

# Use Codex for both phases
il plan --planner codex --reviewer codex "Refactor database layer"
```

**Autonomous Mode (--yolo):**

Skip all permission prompts and proceed automatically:

```bash
# Autonomous fresh planning
il plan --yolo "Add GitLab integration"

# Autonomous decomposition
il plan --yolo 42
```

**Warning:** Autonomous mode will create issues and dependencies without confirmation. Use with caution - it can make irreversible changes to your issue tracker.

**Available MCP Tools in Session:**

| Category | Tools |
|----------|-------|
| Issue Management | `create_issue`, `create_child_issue`, `get_issue`, `get_child_issues`, `get_comment`, `create_comment` |
| Dependency Management | `create_dependency`, `get_dependencies`, `remove_dependency` |
| Codebase Exploration | Read, Glob, Grep, Task |
| Web Research | WebFetch, WebSearch |
| Git Commands | `git status`, `git log`, `git branch`, `git remote`, `git diff`, `git show` |

**Configuration:**

Settings file (`.iloom/settings.json`):
```json
{
  "plan": {
    "model": "opus",
    "planner": "claude",
    "reviewer": "none"
  }
}
```

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `plan.model` | `opus`, `sonnet`, `haiku` | `opus` | Claude model for the planning session |
| `plan.planner` | `claude`, `gemini`, `codex` | `claude` | AI provider for generating plans |
| `plan.reviewer` | `claude`, `gemini`, `codex`, `none` | `none` | AI provider for reviewing plans |

**Examples:**

```bash
# Fresh planning - interactive session
il plan

# Fresh planning - with a topic
il plan "Build user authentication system"

# Fresh planning - with specific model
il plan --model sonnet "Add payment processing"

# Decomposition mode - break down existing issue
il plan 42

# Decomposition mode - Linear issue
il plan ENG-123

# Multi-AI provider - Gemini plans, Claude reviews
il plan --planner gemini --reviewer claude "Add OAuth support"

# Autonomous mode - skip all prompts
il plan --yolo "Add GitLab integration"

# Combine options
il plan --yolo --planner gemini --model sonnet 42
```

**Notes:**
- Must be run from a git repository with a remote configured
- Creates parent epic + child issues following "1 issue = 1 loom = 1 PR" pattern
- Architect sets up blocking dependencies between child issues
- Does NOT create a loom workspace (use `il start` after planning)
- First run may trigger `il init` wizard if repository is not configured

---

## Issue Management Commands

### il add-issue

Create and AI-enhance a new issue without starting a loom.

**Alias:** `a`

**Usage:**
```bash
il add-issue [options] "<description>"
```

**Arguments:**
- `<description>` - Brief or detailed issue description

**Options:**
- `--body <text>` - Pre-formatted body text (skips AI enhancement)

**Workflow:**

1. Creates issue in configured tracker (GitHub or Linear)
2. Runs enhancement agent to expand description (unless `--body` provided)
3. Posts enhancement as issue comment
4. Opens issue in browser

**Examples:**

```bash
# Create a new issue
il add-issue "Add dark mode toggle to settings"

# Create issue with more detail
il add-issue "Users report authentication fails after password reset. Need to investigate token refresh flow."

# Create issue with pre-formatted body (skips AI enhancement)
il add-issue "Add dark mode toggle" --body "## Requirements
- Toggle in settings page
- Persist preference in localStorage

## Acceptance Criteria
- User can switch between light and dark mode"
```

**Notes:**
- Does NOT create a loom workspace
- Useful for backlog grooming and planning
- Enhancement makes issues more actionable for future work
- Use `--body` when you already have detailed requirements written
- Use `il start <issue-number>` later to begin work

---

### il enhance

Apply AI enhancement agent to an existing issue.

**Usage:**
```bash
il enhance [options] <issue-number>
```

**Arguments:**
- `<issue-number>` - Existing issue number from GitHub or Linear

**Options:**

| Flag | Description |
|------|-------------|
| `--no-browser` | Skip browser opening prompt |
| `--author` | GitHub username to tag in questions (for CI usage) |

**Workflow:**

1. Fetches existing issue
2. Analyzes current description and comments
3. Generates enhanced requirements and context
4. Posts enhancement as new issue comment
5. Opens issue in browser (unless `--no-browser`)

**Examples:**

```bash
# Enhance existing issue
il enhance 42

# Enhance without opening browser
il enhance 42 --no-browser

# Enhance and tag specific user in questions
il enhance 42 --author acreeger

# Useful for issues created before iloom adoption
il enhance 127
```

**Notes:**
- Does not modify original issue description
- Posts enhancement as a separate comment
- Can be run multiple times as issue evolves
- Does NOT create a loom workspace
- Useful for CI/automation with `--no-browser` and `--author` flags

---

## Configuration & Maintenance

### il init / il config

Interactive configuration wizard powered by Claude.

**Aliases:** `init`, `config`, `configure`

**Usage:**
```bash
il init [description]
il config [description]
```

**Arguments:**
- `[description]` - Optional natural language description of what to configure

**Workflow:**

Without description (standard wizard):
1. Detects project type and existing configuration
2. Guides through all configuration options
3. Creates/updates `.iloom/settings.json` and `.iloom/settings.local.json`
4. Sets up `.gitignore` entries
5. Validates configuration

With description (natural language):
1. Claude interprets your intent
2. Focuses on specific configuration areas
3. Makes targeted updates

**Examples:**

```bash
# Standard interactive wizard
il init

# Natural language configuration
il init "set my IDE to windsurf and help me configure linear"
il init "switch to github-pr merge mode"
il init "configure neon database with project ID abc-123"
```

**Configuration Areas:**
- Issue tracker (GitHub/Linear)
- Database provider (Neon)
- IDE preference (VS Code, Cursor, Windsurf, etc.)
- Merge behavior (local vs github-pr)
- Permission modes
- Project type (web app, CLI tool, etc.)
- Base port for development servers
- Environment variable names

---

### il update

Update iloom CLI to the latest version.

**Usage:**
```bash
il update [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be done without actually updating |

**Workflow:**

1. Checks npm registry for latest version
2. Compares with currently installed version
3. If update available, installs latest version
4. Displays changelog/release notes

**Examples:**

```bash
# Check for updates and install if available
il update

# Preview update without installing
il update --dry-run
```

**Notes:**
- Uses npm global install under the hood
- Preserves your configuration files
- Safe to run at any time

---

### il feedback

Submit bug reports or feature requests directly to the iloom repository.

**Alias:** `f`

**Usage:**
```bash
il feedback [options] "<description>"
```

**Arguments:**
- `<description>` - Natural language description of feedback (must be >50 chars with >2 spaces)

**Options:**

| Flag | Description |
|------|-------------|
| `--body` | Body text for feedback (added after diagnostics) |

**Workflow:**

1. Creates new issue in [iloom-cli repository](https://github.com/iloom-ai/iloom-cli)
2. Opens issue in browser for you to add context
3. Within minutes, iloom's enhancement agent processes your feedback
4. Issue is prioritized and reviewed

**Examples:**

```bash
# Report a bug
il feedback "The worktree cleanup seems to leave temp files behind"

# Request a feature
il feedback "Add support for GitLab issue tracking"

# Report unexpected behavior
il feedback "Tests fail on finish but Claude doesn't launch to help fix"
```

**Best Practices:**
- Be specific about what you expected vs. what happened
- Include environment details (OS, Node version) for bugs
- Mention the command or workflow that had issues
- Suggest improvements or alternative approaches

---

### il contribute

Fork, clone, and set up a GitHub repository for contribution (defaults to iloom-cli).

**Usage:**
```bash
il contribute [repository]
```

**Arguments:**
- `[repository]` - GitHub repository to contribute to (defaults to iloom-cli)
  - Full URL: `https://github.com/owner/repo`
  - Short URL: `github.com/owner/repo`
  - Owner/repo: `owner/repo`

**Workflow:**

1. Forks the repository to your GitHub account (if not already forked)
2. Clones your fork locally
3. Sets up upstream remote to track the original repository
4. Configures iloom settings:
   - Sets `issueManagement.github.remote` to `upstream`
   - Sets `mergeBehavior.mode` to `github-draft-pr`

**Examples:**

```bash
# Set up iloom development environment (default)
il contribute

# Contribute to any GitHub repository
il contribute "https://github.com/n8n-io/n8n"
il contribute "github.com/vercel/next.js"
il contribute "facebook/react"
```

**Notes:**
- Requires GitHub CLI (`gh`) to be authenticated
- Creates fork if it doesn't exist
- Sets up `github-draft-pr` mode so PRs are created immediately when you start work
- Draft PRs receive iloom's AI analysis and planning comments, giving maintainers full context
- For iloom contributions, see [CONTRIBUTING.md](../CONTRIBUTING.md) for detailed guidelines

---

## Global Flags

Some flags work across multiple commands:

| Flag | Commands | Description |
|------|----------|-------------|
| `--one-shot` | `start`, `spin` | Automation level for Claude workflows |
| `--yolo` | `start`, `spin`, `plan` | Shorthand for `--one-shot=bypassPermissions` (autonomous mode) |
| `--force`, `-f` | `finish`, `rebase` | Skip confirmation prompts |
| `--dry-run`, `-n` | `finish`, `rebase` | Preview without executing |
| `--help`, `-h` | All commands | Display command help |
| `--version`, `-v` | All commands | Display iloom version |

---

## Environment Variables

iloom respects these environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ILOOM_SETTINGS_PATH` | Override default settings file location | `~/.config/iloom-ai/settings.json` |
| `ILOOM_NO_COLOR` | Disable colored output | `false` |
| `ILOOM_DEBUG` | Enable debug logging | `false` |
| `ILOOM_DEV_SERVER_TIMEOUT` | Dev server startup timeout in milliseconds | `180000` (180 seconds) |
| `CLAUDE_API_KEY` | Claude API key (if not using Claude CLI) | - |

---

## Additional Resources

- [Main README](../README.md) - Overview and quick start
- [Configuration Guide](./configuration.md) - Detailed configuration options
- [Troubleshooting Guide](./troubleshooting.md) - Common issues and solutions
- [Contributing Guide](../CONTRIBUTING.md) - How to contribute to iloom
