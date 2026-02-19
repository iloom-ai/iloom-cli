---
description: Ship changes by creating a worktree, PR, merging, and rebuilding
args:
  - name: branchName
    description: Optional branch name (will be derived from changes if not provided)
    required: false
---

Ship the current uncommitted changes through a complete PR workflow using a worktree.

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

### 2. Stash Changes

Stash all uncommitted changes (including untracked files):
```bash
git stash push -u -m "quick-fix: <branch-name>"
```

### 3. Create Worktree

Create a worktree for the feature branch:
```bash
git worktree add -b <branch-name> ../<repo-name>_quick-fix_<branch-name> HEAD
```

### 4. Apply Stashed Changes in Worktree

```bash
cd ../<repo-name>_quick-fix_<branch-name>
git stash pop
```

### 5. Install Dependencies

Worktrees don't have `node_modules`, so install dependencies to enable Husky pre-commit hooks:

```bash
cd ../<repo-name>_quick-fix_<branch-name>
pnpm install
```

### 6. Stage and Commit Changes

Check recent commit messages for style:
```bash
git log --oneline -5
```

Stage all changes and commit with a conventional commit message following the repo's style (e.g., `feat(scope): description` or `fix(scope): description`).

### 7. Push to Remote

```bash
git push -u origin <branch-name>
```

### 8. Create Pull Request

Use `gh pr create` with a clear title and summary body. Include:
- Summary of changes (bullet points)
- Test plan if applicable

### 9. Return to Original Directory and Remove Worktree

Return to original directory and remove the worktree before merging (to avoid branch conflicts):
```bash
cd <original-directory>
git worktree remove ../<repo-name>_quick-fix_<branch-name>
```

### 10. Merge Pull Request

```bash
gh pr merge <pr-number> --squash --delete-branch
git pull --prune
```

### 11. Rebuild

```bash
pnpm build
```

## Notes

- Worktrees don't have `node_modules`, so step 5 installs deps to enable Husky pre-commit hooks
- Do NOT skip step 5 — without it, pre-commit hooks won't run and broken code can be merged
- Uses a worktree to isolate changes from the main working directory
- The PR is merged with squash to keep history clean
- Remote branch is automatically deleted after merge
- Worktree is cleaned up after successful merge
