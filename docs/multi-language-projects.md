# Multi-Language Project Support

## Overview

iloom supports projects in any programming language, not just Node.js. Whether you're working with Python, Rust, Ruby, Go, or any other language, iloom can provide isolated development environments for your feature branches.

The key to multi-language support is the `.iloom/package.iloom.json` configuration file, which defines your project's capabilities and scripts. This file works alongside (or instead of) `package.json` and allows iloom to manage non-Node.js projects effectively.

### Supported Languages

While iloom has native support for Node.js projects, it also supports:
- Python (pip/venv, Poetry, PDM)
- Rust (Cargo)
- Ruby (Bundler, Rails)
- Go (go modules)
- Java/Kotlin (Gradle, Maven)
- PHP (Composer)
- Any language with command-line build tools

## Quick Start (Recommended)

The easiest way to configure iloom for your project is to use the interactive setup:

```bash
il init
```

The framework detector agent will:
1. Analyze your project structure and detect your programming language
2. Identify common build tools, test frameworks, and dev servers
3. Generate a `.iloom/package.iloom.json` configuration file
4. Prompt you to review and customize the detected configuration

This interactive flow ensures your configuration is tailored to your project without requiring manual file creation.

## Manual Configuration

If you prefer to configure iloom manually or need to customize an existing configuration, create or edit `.iloom/package.iloom.json` in your project root.

### File Location

```
your-project/
├── .iloom/
│   └── package.iloom.json
├── src/
└── ...
```

### Full Configuration Format

```json
{
  "name": "my-project",
  "capabilities": ["cli", "web"],
  "scripts": {
    "install": "cargo fetch",
    "build": "cargo build --release",
    "test": "cargo test",
    "dev": "cargo run --bin my-project",
    "lint": "cargo clippy",
    "typecheck": "cargo check"
  }
}
```

### Configuration Options

#### `name` (optional)
The project name. Used for display purposes.

#### `capabilities` (required)
An array defining what type of project this is:
- `"cli"` - Command-line application that produces executable binaries
  - Enables CLI isolation (unique binary paths per loom)
  - Ensures each workspace can have its own built binaries
- `"web"` - Web application with a development server
  - Enables automatic port assignment (3000 + issue number)
  - Prevents port conflicts when running multiple dev servers
- `"ios"` - iOS application built with Xcode
  - Enables iOS-specific build configuration (simulator device, scheme, bundle ID, etc.)
  - Activates Xcode build strategy for dev server commands

You can specify both capabilities if your project is both a CLI and web app.

#### `scripts` (optional)
Shell commands for common development tasks. All scripts are optional - if not defined, that step is skipped.

| Script | Purpose | When Used |
|--------|---------|-----------|
| `install` | Install dependencies | `il start` (loom creation), `il finish` (post-merge) |
| `build` | Compile/build project | `il build`, `il finish` (CLI projects, post-merge) |
| `test` | Run test suite | `il test`, `il finish` validation |
| `dev` | Start dev server | `il dev-server` |
| `lint` | Run linter | `il lint`, `il finish` validation |
| `typecheck` | Type checking | `il typecheck`, `il finish` validation |
| `compile` | Alternative to typecheck | `il compile`, `il finish` validation (preferred over typecheck if both exist) |

## Language Examples

### Python with pip/venv

```json
{
  "name": "my-python-app",
  "capabilities": ["web"],
  "scripts": {
    "install": "python -m pip install -e .",
    "build": "python -m pip install -e .",
    "test": "pytest tests/",
    "dev": "python -m uvicorn app.main:app --reload --port $PORT",
    "lint": "ruff check .",
    "typecheck": "mypy src/"
  }
}
```

### Python with Poetry

```json
{
  "name": "my-poetry-app",
  "capabilities": ["web"],
  "scripts": {
    "install": "poetry install",
    "build": "poetry install",
    "test": "poetry run pytest",
    "dev": "poetry run python -m uvicorn app.main:app --reload --port $PORT",
    "lint": "poetry run ruff check .",
    "typecheck": "poetry run mypy src/"
  }
}
```

### Rust with Cargo

```json
{
  "name": "my-rust-app",
  "capabilities": ["cli", "web"],
  "scripts": {
    "install": "cargo fetch",
    "build": "cargo build --release",
    "test": "cargo test",
    "dev": "cargo run --bin server -- --port $PORT",
    "lint": "cargo clippy -- -D warnings",
    "typecheck": "cargo check"
  }
}
```

### Ruby with Rails

```json
{
  "name": "my-rails-app",
  "capabilities": ["web"],
  "scripts": {
    "install": "bundle install",
    "build": "bundle exec rails assets:precompile",
    "test": "bundle exec rspec",
    "dev": "bundle exec rails server -p $PORT",
    "lint": "bundle exec rubocop"
  }
}
```

### Ruby with Bundler (non-Rails)

```json
{
  "name": "my-ruby-app",
  "capabilities": ["cli"],
  "scripts": {
    "install": "bundle install",
    "test": "bundle exec rspec",
    "lint": "bundle exec rubocop",
    "typecheck": "bundle exec steep check"
  }
}
```

### Go

```json
{
  "name": "my-go-app",
  "capabilities": ["cli", "web"],
  "scripts": {
    "install": "go mod download",
    "build": "go build -o ./bin/myapp ./cmd/myapp",
    "test": "go test ./...",
    "dev": "go run ./cmd/server -port $PORT",
    "lint": "golangci-lint run",
    "typecheck": "go vet ./..."
  }
}
```

### Java with Gradle

```json
{
  "name": "my-java-app",
  "capabilities": ["web"],
  "scripts": {
    "install": "./gradlew dependencies",
    "build": "./gradlew build",
    "test": "./gradlew test",
    "dev": "./gradlew bootRun --args='--server.port=$PORT'",
    "lint": "./gradlew checkstyleMain"
  }
}
```

### PHP with Composer

```json
{
  "name": "my-php-app",
  "capabilities": ["web"],
  "scripts": {
    "install": "composer install",
    "test": "vendor/bin/phpunit",
    "dev": "php -S localhost:$PORT -t public",
    "lint": "vendor/bin/phpcs"
  }
}
```

## How Scripts Are Executed

Understanding how iloom executes scripts helps you write effective configurations:

### package.iloom.json Scripts
Scripts defined in `package.iloom.json` are executed directly as shell commands:
```bash
sh -c "<command>"
```

This means:
- You have full shell capabilities (pipes, environment variables, etc.)
- Scripts run in your project's root directory
- The `$PORT` environment variable is available for web apps
- You must include the full command (e.g., `poetry run pytest`, not just `pytest`)

### package.json Scripts (Node.js projects)
If `package.json` exists, scripts are executed via your package manager:
```bash
pnpm run <script>  # or npm/yarn depending on your lock file
```

### Precedence Rules
When both `package.iloom.json` and `package.json` exist:
1. `package.iloom.json` scripts take precedence
2. If a script is not defined in `package.iloom.json`, iloom falls back to `package.json`
3. This allows gradual migration or hybrid configurations

### Environment Variables
iloom automatically provides:
- `$PORT` - Unique port for web apps (3000 + issue number)
- All variables from your `.env` file (modified for the current loom)

## Commands

Once configured, use these iloom commands to work with your project:

### `il build`
Runs the `build` script from your configuration:
```bash
il build
```

This is equivalent to executing the build command directly, but provides a consistent interface across all projects.

### `il test`
Runs the `test` script:
```bash
il test
```

### `il lint`
Runs the `lint` script:
```bash
il lint
```

### `il dev-server`
Runs the `dev` script for web applications:
```bash
il dev-server
```

This command automatically sets the `$PORT` environment variable based on the current loom's issue number.

## Capabilities

### CLI Capability

Declare `"cli"` capability when your project produces executable binaries:

```json
{
  "capabilities": ["cli"]
}
```

This tells iloom that:
- Your project has build artifacts (binaries, executables)
- Each loom should have isolated binary paths
- Build outputs should not conflict between looms

**Use cases:**
- Command-line tools
- Binary applications
- Anything that compiles to an executable

### Web Capability

Declare `"web"` capability when your project runs a development server:

```json
{
  "capabilities": ["web"]
}
```

This tells iloom that:
- Your project needs a unique port per loom
- Port conflicts should be prevented
- The `$PORT` variable should be provided
- It should start a web server when you start a new loom

**Use cases:**
- Web applications
- API servers
- Any application that listens on a network port

### Both Capabilities

Some projects are both CLI and web applications:

```json
{
  "capabilities": ["cli", "web"]
}
```

**Example:** A Rust web framework that:
- Compiles to a binary (`cli`)
- Runs a web server (`web`)

### iOS Capability

Declare `"ios"` capability when your project is an iOS application built with Xcode:

```json
{
  "capabilities": ["ios"]
}
```

This tells iloom that:
- Your project uses Xcode for building and running
- iOS-specific settings (simulator device, scheme, bundle ID, etc.) apply
- The dev server strategy will use `xcodebuild` or `simctl`

**Use cases:**
- Native iOS apps
- Swift Package Manager libraries with iOS targets
- iOS app extensions

#### iOS-Specific Settings

Configure iOS build behavior in `.iloom/settings.json` under the `capabilities.ios` key:

```json
{
  "capabilities": {
    "ios": {
      "simulatorDevice": "iPhone 16",
      "scheme": "MyApp",
      "bundleId": "com.example.myapp",
      "configuration": "Debug",
      "deployTarget": "simulator",
      "developmentTeam": "TEAM123456"
    }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `simulatorDevice` | string | `"iPhone 16"` | Target simulator device name |
| `scheme` | string | — | Xcode scheme to build |
| `bundleId` | string | — | App bundle identifier |
| `configuration` | `"Debug"` \| `"Release"` | `"Debug"` | Build configuration |
| `deployTarget` | `"simulator"` \| `"device"` | `"simulator"` | Whether to deploy to simulator or physical device |
| `developmentTeam` | string | — | Apple Developer Team ID (required for physical device deployment) |

## Secret Storage Limitations

iloom's environment variable isolation works by managing `.env` files. Features like database branching and loom-specific environment variables require your framework to read configuration from `.env` files.

### Not Supported

The following secret/config storage mechanisms are **not managed by iloom**. If your framework uses these, database branching and per-loom environment isolation will not work:

- **Rails Encrypted Credentials** (`config/credentials.yml.enc`)
- **ASP.NET User Secrets** (stored in user profile)
- **SOPS** (Secrets OPerationS) encrypted files
- **Kubernetes Secrets** / **Docker Secrets**
- **Cloud Provider Secrets** (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault)

To use iloom's isolation features with these frameworks, you must configure them to read from `.env` files instead.

### Example: Rails

To enable database branching with Rails, configure it to read from environment variables:

```ruby
# config/database.yml
development:
  password: <%= ENV['DATABASE_PASSWORD'] %>

# .env
DATABASE_PASSWORD=secret123
```

iloom will automatically create loom-specific copies of `.env` with isolated database URLs.

## Troubleshooting

### "No build script defined"

**Problem:** Running `il build` fails with "No build script defined in package.iloom.json"

**Solution:** Add a `build` script to your `.iloom/package.iloom.json`:
```json
{
  "scripts": {
    "build": "your-build-command"
  }
}
```

Or run `il init` to auto-detect your build command.

### "Command not found" in scripts

**Problem:** Script fails with "command not found" error

**Possible causes:**
1. Command requires a package manager prefix (Poetry, Bundler, etc.)
2. Command is not in PATH
3. Virtual environment is not activated

**Solutions:**
- Use full command path: `poetry run pytest` not `pytest`
- Activate environment in script: `source venv/bin/activate && pytest`
- Use absolute paths: `/usr/local/bin/mycommand`

### Port conflicts

**Problem:** Dev server fails to start because port is in use

**Solutions:**
1. Ensure your `dev` script uses `$PORT` variable
2. Declare `"web"` capability in `package.iloom.json`
3. Check if another loom is using the same issue number

### Scripts not using loom-specific environment

**Problem:** Scripts are using the wrong database or environment variables

**Possible causes:**
1. Script is not reading from `.env`
2. Framework has its own config system
3. Variables are hardcoded

**Solutions:**
- Configure your framework to read from environment variables
- Use standard `.env` files instead of framework-specific config
- See "Secret Storage Limitations" above

### Build artifacts conflicting between looms

**Problem:** Building in one loom affects another loom

**Solutions:**
1. Configure build output to use relative paths. Since looms use git worktrees, each loom already has its own directory. Build artifacts are naturally isolated as long as they're relative to the project root (e.g., `./target`, `./build`, `./dist`)
2. If you're building a CLI tool, make sure that the capabilities array includes `cli`.

### Auto-detection not working

**Problem:** `il init` doesn't detect your framework correctly

**Solution:**

Option 1:

Tell the init agent how you want the scripts to be configured!

Option 2:

Manually create `.iloom/package.iloom.json` using the examples above as a template. The auto-detection is a convenience feature, but manual configuration is fully supported.

### Scripts work locally but not in iloom

**Problem:** Commands work when run directly but fail through `il build`, `il test`, etc.

**Possible causes:**
1. Different working directory
2. Missing environment variables
3. Shell environment differences

**Solutions:**
- Scripts run from project root, use relative paths
- Check if environment variables are defined in `.env`
- Use explicit paths and avoid shell aliases
- Use the `--debug` flag to see exactly what commands are being executed:
  ```bash
  il --debug build
  ```
  Note: Debug output can be verbose, but it will show the exact shell command and arguments being passed.

---

For more information, see the main [README.md](../README.md) or run `il --help`.
