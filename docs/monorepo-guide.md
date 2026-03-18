# Monorepo Support in iloom

This guide explains how iloom detects and works with monorepo projects, how package detection works, and how validation and dev server commands are scoped to specific packages.

## What is Monorepo Support?

Monorepo support means iloom is aware that your repository contains multiple packages in subdirectories and can scope its commands — validation, testing, linting, and the dev server — to only the packages relevant to a given loom's changes. This keeps CI-style commands fast and avoids running tests for packages that were not touched.

## How Monorepo Detection Works

iloom detects the `monorepo` capability automatically during `il init` by looking for workspace configuration files in the repository root:

- **`pnpm-workspace.yaml`** — used by pnpm workspaces
- **`workspaces` field in `package.json`** — used by yarn and npm workspaces

When either is present, iloom adds `"monorepo"` to the `capabilities` array in `.iloom/package.iloom.json`:

```json
{
  "capabilities": ["monorepo", "web"]
}
```

You can also add `"monorepo"` manually to `.iloom/package.iloom.json` if auto-detection does not apply to your project layout.

## The Package Detection Agent

When the `monorepo` capability is set, iloom integrates a dedicated `iloom-monorepo-package-detector` agent into the workflow.

**What it does:**

1. The agent explores the loom's workspace, examines the issue context, and determines which packages were touched or need to run.
2. It calls MCP tools to write two arrays to the loom metadata file (`~/.config/iloom-ai/looms/<slug>.json`):
   - `packagesToRun` — packages whose dev server should be started (relative paths from repo root, e.g., `./apps/web`)
   - `packagesToValidate` — packages that `il test`, `il lint`, `il compile`, and `il build` should be scoped to (relative paths from repo root, e.g., `./packages/api`, `./apps/web`)

**When it runs:**

- **Non-swarm mode**: the detection agent runs before the implementation agent begins.
- **Swarm mode**: the detection agent runs after the swarm completes, called by the orchestrator. Individual child agents do not invoke it directly.

**UserPromptSubmit hook reminder:**

When `monorepo` capability is set, a `UserPromptSubmit` hook injects a reminder into each agent session: if the agent touches packages not already listed in `packagesToValidate`, it should call `mcp__recap__set_packages_to_validate` to update the list.

## How `packagesToRun` and `packagesToValidate` Work

Both fields are arrays of relative paths from the repository root. They live in the loom metadata file at `~/.config/iloom-ai/looms/<slug>.json`.

| Field | Used by | Purpose |
|-------|---------|---------|
| `packagesToRun` | `il dev-server` | Which package's dev server to start |
| `packagesToValidate` | `il test`, `il lint`, `il compile`, `il build` | Which packages to scope validation to |

These fields are set by the package detection agent. They can also be set manually via MCP tools (`mcp__recap__set_package_to_run`, `mcp__recap__set_packages_to_validate`) if you need to override the agent's decision.

When a field is empty or not set, the corresponding command runs at the project root, covering the entire repository — the same behavior as for non-monorepo looms.

## How Commands Are Scoped

When `packagesToValidate` contains one or more packages, `il test`, `il lint`, `il compile`, and `il build` pass those packages to the package manager's workspace filter mechanism:

| Package Manager | Filter syntax |
|-----------------|--------------|
| **pnpm** | `pnpm --filter ./pkg1 --filter ./pkg2 run <script> --if-present` |
| **npm** | `npm run <script> --workspace=./pkg1 --workspace=./pkg2 --if-present` |
| **yarn (berry)** | `yarn workspaces foreach --include ./pkg1 --include ./pkg2 run <script>` |

Packages that do not define the target script are gracefully skipped (`--if-present` / `--if-present` equivalent).

When `packagesToValidate` is empty (no packages detected, or a non-monorepo loom), the commands run at the project root without any filter, giving you normal full-repo behavior.

## Dev Server Metadata Watching

When both `web` and `monorepo` capabilities are detected, `il dev-server` needs to know which package's dev server to launch. It reads `packagesToRun` from the loom metadata:

1. If `packagesToRun` is already set when `il dev-server` starts, the server launches immediately from that package's subdirectory.
2. If `packagesToRun` is empty, `il dev-server` watches the metadata file (with a 15-second polling fallback) and launches once the package detection agent populates the field.
3. Only the first package in `packagesToRun` is used — multi-package dev servers are not supported in v1.
4. `il dev-server` times out after 60 seconds with an actionable error if the agent never runs.

For non-monorepo looms (or when only the `web` capability is set), `il dev-server` starts from the workspace root immediately, unchanged from pre-monorepo behavior.

## Non-Monorepo Projects Are Unaffected

Projects without the `monorepo` capability behave identically to before. The `packagesToValidate` and `packagesToRun` fields default to empty arrays, and all commands run at the project root without any workspace filters.

## Example: Full Loom Lifecycle for a Monorepo

```
1. il start 123
   └── il init previously detected monorepo capability via pnpm-workspace.yaml

2. Package detection agent runs (before implementation agent in non-swarm mode)
   └── Sets packagesToRun: ["./apps/web"]
   └── Sets packagesToValidate: ["./apps/web", "./packages/ui"]

3. Implementation agent works on the issue

4. il test
   └── Reads packagesToValidate from loom metadata
   └── Runs: pnpm --filter ./apps/web --filter ./packages/ui run test --if-present

5. il lint
   └── Runs: pnpm --filter ./apps/web --filter ./packages/ui run lint --if-present

6. il compile
   └── Runs: pnpm --filter ./apps/web --filter ./packages/ui run compile --if-present

7. il dev-server
   └── Reads packagesToRun from loom metadata
   └── Starts dev server in ./apps/web/

8. il finish 123
```

## Manual Override

If the detection agent sets the wrong packages, you can override them before running validation:

```bash
# Via the MCP tool (in an agent session)
mcp__recap__set_packages_to_validate(["./apps/web", "./packages/shared"])

# Or by editing the metadata file directly
# ~/.config/iloom-ai/looms/<slug>.json
```

## Troubleshooting

**Detection agent never ran / metadata is empty:**
- Confirm `"monorepo"` is in `.iloom/package.iloom.json` `capabilities`
- In swarm mode, confirm the orchestrator called the detection agent after swarm completion
- In non-swarm mode, confirm the pre-agent hook is configured

**Dev server times out waiting for `packagesToRun`:**
- Check whether the detection agent completed without error
- As a workaround, set `packagesToRun` manually via `mcp__recap__set_package_to_run`

**Commands run against the entire monorepo instead of scoped packages:**
- `packagesToValidate` is empty — either the detection agent has not run yet, or no packages were detected
- You can set packages manually or re-run the detection agent
