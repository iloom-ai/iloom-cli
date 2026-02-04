---
description: Ship changes by creating a branch, PR, merging, and rebuilding
args:
  - name: branchName
    description: Optional branch name (will be derived from changes if not provided)
    required: false
---

Ship the current uncommitted changes through a complete PR workflow.

## Workflow Steps

### 1. Analyze Changes and Determine Branch Name

First, check what's changed:
```bash
git status
git diff --stat
```

{{#if branchName}}
Use the provided branch name: `{{branchName}}`
{{else}}
Derive an appropriate branch name from the changes:
- Look at which files changed and what the changes do
- Use conventional format: `feat/short-description`, `fix/short-description`, `chore/short-description`, etc.
- Keep it concise but descriptive (e.g., `feat/configurable-dev-server-timeout`)
{{/if}}

### 2. Create Feature Branch

```bash
git checkout -b <branch-name>
```

### 3. Stage and Commit Changes

Check recent commit messages for style:
```bash
git log --oneline -5
```

Stage all changes and commit with a conventional commit message following the repo's style (e.g., `feat(scope): description` or `fix(scope): description`).

### 4. Push to Remote

```bash
git push -u origin <branch-name>
```

### 5. Create Pull Request

Use `gh pr create` with a clear title and summary body. Include:
- Summary of changes (bullet points)
- Test plan if applicable

### 6. Merge Pull Request

```bash
gh pr merge <pr-number> --squash --delete-branch
```

### 7. Return to Main and Sync

```bash
git checkout main && git pull --prune
```

### 8. Rebuild

```bash
pnpm build
```

## Notes

- This command assumes all changes are ready to ship (tests pass, linting clean)
- The PR is merged with squash to keep history clean
- Remote branch is automatically deleted after merge
- Local tracking branches are pruned during pull
