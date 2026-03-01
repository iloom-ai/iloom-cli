# iloom on Windows (WSL)

iloom runs on Windows through **Windows Subsystem for Linux (WSL)**. It does **not** run natively in PowerShell or Command Prompt. All iloom commands must be run from inside a WSL distribution.

## Installing iloom

Before installing iloom, you'll need these prerequisites set up inside WSL:

- [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) with a Linux distribution (Ubuntu recommended)
- [Windows Terminal](https://aka.ms/terminal) (pre-installed on Windows 11)
- [Node.js 22+](https://github.com/nvm-sh/nvm#installing-and-updating) installed inside WSL (not the Windows version)
- [Git 2.5+](https://git-scm.com/) installed inside WSL
- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated inside WSL
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code/overview) installed inside WSL

Then install iloom from inside your WSL terminal:

```bash
npm install -g @iloom/cli
```

If you need help setting up the prerequisites, see [Setting up WSL](#setting-up-wsl) below.

## Using VS Code with WSL

You must open VS Code **from WSL**, not from Windows. This ensures VS Code's integrated terminal runs inside WSL where iloom is installed.

```bash
# Navigate to your project inside WSL
cd ~/projects/my-app

# Open VS Code from WSL — this launches VS Code with the WSL remote extension
code .
```

When you do this, VS Code will:
- Install the **WSL extension** automatically (first time only)
- Show "WSL: Ubuntu" (or your distro name) in the bottom-left corner
- Run its integrated terminal inside WSL
- Have access to all your WSL-installed tools (Node.js, Git, iloom, Claude CLI)

### Do NOT open from Windows Explorer

If you open VS Code from the Windows Start menu or by double-clicking a folder in Windows Explorer, it runs in Windows mode. The integrated terminal will be PowerShell, and iloom won't work. Always use `code .` from your WSL terminal.

### iloom VS Code extension

Once VS Code is open in WSL mode (via `code .` from your WSL terminal), install the iloom extension from the Extensions panel. Because VS Code is running in WSL, the extension runs inside WSL too — it has full access to iloom, Claude CLI, and your development tools.

### Verifying your setup

In VS Code's integrated terminal, run:

```bash
# Should show a Linux path like /home/username/projects/my-app
pwd

# Should show "Linux"
uname -s

# Should work without errors
il --version
```

If `pwd` shows a Windows path (like `/mnt/c/Users/...`), you're accessing Windows files through WSL. While this works, it's significantly slower than using files stored natively in WSL (like `~/projects/`). For best performance, keep your projects in your WSL home directory.

## How iloom uses Windows Terminal

When you run `il start <issue>`, iloom detects that you're in WSL and:

1. Launches **Windows Terminal** (`wt.exe`) to open new tabs
2. Each tab runs inside your WSL distribution automatically
3. Terminal tabs get titled with the task context (e.g., "Dev Server", "Claude")

Your development terminals appear as native Windows Terminal tabs alongside your other terminal sessions.

## Setting up WSL

If you don't have the prerequisites yet, follow these steps.

### 1. Install WSL

Open PowerShell as Administrator and run:

```powershell
wsl --install
```

This installs WSL 2 with Ubuntu by default. Restart your computer when prompted.

### 2. Install Windows Terminal

Install from the [Microsoft Store](https://aka.ms/terminal) if you don't have it already. On Windows 11, it's pre-installed.

### 3. Set up your WSL environment

Open your WSL terminal (Ubuntu) and install the tools:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (using nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22

# Install GitHub CLI
(type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

# Authenticate with GitHub
gh auth login

# Install Claude CLI
npm install -g @anthropic-ai/claude-code

# Verify everything
node --version   # Should be 22+
git --version    # Should be 2.5+
gh --version     # Should show gh version
claude --version # Should show Claude CLI version
```

## Troubleshooting

### "Windows Terminal (wt.exe) is not available"

Install Windows Terminal from the [Microsoft Store](https://aka.ms/terminal). It's required for iloom to open terminal tabs from WSL.

### iloom commands not found

Make sure you installed iloom inside WSL, not in Windows PowerShell:

```bash
# Run this inside WSL
which il
# Should show something like /home/username/.nvm/versions/node/v22.x.x/bin/il
```

### VS Code not detecting WSL

Install the [WSL extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl) for VS Code. Then always open projects with `code .` from your WSL terminal.

### Slow file access

If you're working with files on the Windows filesystem (paths starting with `/mnt/c/`), file operations will be slow due to the WSL-Windows filesystem bridge. Move your projects to your WSL home directory for much better performance:

```bash
# Move project to WSL native filesystem
cp -r /mnt/c/Users/you/projects/my-app ~/projects/my-app
cd ~/projects/my-app
```

### tmux fallback

If Windows Terminal is unavailable for some reason, iloom can fall back to **tmux** (a terminal multiplexer). Install it with:

```bash
sudo apt install tmux
```

iloom will automatically use tmux when no GUI terminal is available (e.g., in SSH sessions or Docker containers).
