# src/migrations/

> **Maintenance:** Keep this file in sync when adding new migrations.

Migrations run automatically on CLI startup via `VersionMigrationManager`. They handle one-time setup tasks that can't be done at install time (e.g., global gitignore entries).

## How Migrations Work

1. State stored in `~/.config/iloom-ai/migration-state.json` → `lastMigratedVersion`
2. On startup, `VersionMigrationManager` runs migrations where: `lastMigratedVersion < migration.version <= currentPackageVersion`
3. After all migrations run, `lastMigratedVersion` is updated to the current package version

## Versioning Convention

A new migration's version should be **one patch version higher** than the current `package.json` version.

Example: if `package.json` is at `0.13.1`, the next migration should be `0.13.2`.

**Before creating a new migration**, check if an unreleased migration already exists at that version (`git tag` to confirm). If so, fold your logic into the existing migration rather than creating a duplicate.

## Writing a Migration

Migrations are defined in `index.ts` as objects in the `migrations` array:

```typescript
{
  version: '0.13.2',
  description: 'Brief description of what this migration does',
  migrate: async () => {
    // Migration logic here
  }
}
```

**Requirements:**
- **Idempotent**: Safe to run multiple times. Check before modifying (e.g., check if gitignore entry already exists before adding).
- **No user interaction**: Migrations run silently on startup.
- **Fail gracefully**: Log warnings but don't crash the CLI.

## Existing Migrations

| Version | Description |
|---------|-------------|
| 0.6.1 | Global gitignore for `.iloom/settings.local.json` |
| 0.7.1 | Global gitignore for `.iloom/package.iloom.local.json` |
| 0.9.3 | Global gitignore for `.claude/agents/iloom-*`, `.claude/skills/iloom-*`, MCP config |
| 0.10.3 | Remediate gitignore path (supports custom `core.excludesFile`) |
| 0.13.1 | Global gitignore for `.env.local`, `.env.*.local` |

Common pattern: most migrations use `ensureGlobalGitignorePatterns()` to add entries to the global gitignore, handling both XDG default and custom `core.excludesFile` paths.
