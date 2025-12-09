# gh-forecast

> 📊 Forecast your GitHub Actions minutes usage for GHES (GitHub Enterprise Server) organizations

A GitHub CLI extension that analyzes workflow run history and calculates estimated GitHub Actions costs based on job durations and OS multipliers.

## Why?

GHES self-hosted runners don't report "billable minutes" the same way GitHub.com does. This tool reconstructs the job history and applies GitHub's billing multipliers to give you a cost estimate if you were to migrate to GitHub-hosted runners.

## Quick Start

```bash
# Set your token
export GH_TOKEN="ghp_xxxxxxxxxxxx"

# 🚀 Run instantly with npx (no install required!)
npx gh-forecast --org my-org --host github.mycompany.com
```

That's it! The tool will analyze the last 30 days of workflow runs and show you cost estimates.

## Installation

### Option 1: npx (Recommended for one-off usage)

```bash
npx gh-forecast --org my-org
```

### Option 2: Global npm install

```bash
npm install -g gh-forecast
gh-forecast --org my-org
```

### Option 3: GitHub CLI Extension

```bash
gh extension install austenstone/gh-ghes-actions-forecast
gh ghes-actions-forecast --org my-org
```

## Usage

```bash
# Basic usage - analyze the last 30 days
gh-forecast --org my-org

# Analyze a different time period
gh-forecast --org my-org --days 90

# Custom date range
gh-forecast --org my-org --start 2024-01-01 --end 2024-03-31

# Connect to GitHub Enterprise Server
gh-forecast --org my-org --host github.mycompany.com

# Custom label-to-OS mappings for self-hosted runners
gh-forecast --org my-org --map "runner-*:linux,mac-builder:macos"

# Output as JSON for further processing
gh-forecast --org my-org --output json

# Output as CSV for spreadsheets
gh-forecast --org my-org --output csv

# Group by week or month
gh-forecast --org my-org --group-by week
gh-forecast --org my-org --group-by month

# Show workflow and job breakdown
gh-forecast --org my-org --show-workflows --show-jobs

# Clear cached data
gh-forecast --clear-cache --org my-org

# Disable caching for fresh data
gh-forecast --org my-org --no-cache
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --org <org>` | GitHub organization name (required) | - |
| `-d, --days <days>` | Number of days to analyze | `30` |
| `--start <date>` | Start date (YYYY-MM-DD) | - |
| `--end <date>` | End date (YYYY-MM-DD) | today |
| `-H, --host <host>` | GitHub Enterprise Server hostname | `github.com` |
| `-c, --concurrency <n>` | API request concurrency limit | `5` |
| `-m, --map <mappings>` | Custom label-to-OS mappings | - |
| `--output <format>` | Output format: `table`, `json`, `csv` | `table` |
| `--group-by <period>` | Group results: `day`, `week`, `month` | `day` |
| `--top-repos <n>` | Show top N repositories by usage | `10` |
| `--show-workflows` | Show workflow-level breakdown | `false` |
| `--show-jobs` | Show individual job details | `false` |
| `--no-cache` | Disable caching | - |
| `--clear-cache` | Clear all cached data and exit | - |
| `--cache-ttl <min>` | Cache TTL in minutes | `30` |
| `--verbose` | Show detailed progress | `false` |

## Authentication

The extension uses authentication in this priority order:

1. `GH_TOKEN` environment variable
2. `GH_ENTERPRISE_TOKEN` environment variable  
3. `gh auth token` (from the gh CLI's stored credentials)

For GHES, make sure you've authenticated:

```bash
# Using environment variable (recommended for npx)
export GH_TOKEN="ghp_xxxxxxxxxxxx"

# Or authenticate with gh CLI
gh auth login --hostname github.mycompany.com
```

## Example Output

```
📊 GitHub Actions Forecast
   Organization: my-org
   Date range: 2024-11-08 to 2024-12-08 (30 days)
   Cache: 3 files (6.0 KB)

  Authenticating... ✓
  ████████████████████████████████████████ | Fetching repos     | 50/50 | ETA: 0s
  ████████████████████████████████████████ | Fetching runs      | 50/50 | ETA: 0s
  ████████████████████████████████████████ | Fetching jobs      | 234/234 | ETA: 0s

  Completed in 4.2s: 50 repos, 234 runs, 1,456 jobs

📊 Results for my-org
   Period: Nov 8, 2024 - Dec 8, 2024

┌─────────────────────────────┬───────────┐
│ Metric                      │ Value     │
├─────────────────────────────┼───────────┤
│ Total Workflow Runs         │ 234       │
├─────────────────────────────┼───────────┤
│ Total Jobs                  │ 1,456     │
├─────────────────────────────┼───────────┤
│ Total Minutes               │ 45,230    │
├─────────────────────────────┼───────────┤
│ Billable Minutes (weighted) │ 67,845    │
├─────────────────────────────┼───────────┤
│ Estimated Cost (period)     │ $543.60   │
└─────────────────────────────┴───────────┘

🖥️  Usage by Operating System:

┌─────────┬────────┬─────────┬────────────┬──────────────┐
│ OS      │ Jobs   │ Minutes │ Multiplier │ Billable Min │
├─────────┼────────┼─────────┼────────────┼──────────────┤
│ Linux   │ 1,234  │ 38,500  │ 1x         │ 38,500       │
├─────────┼────────┼─────────┼────────────┼──────────────┤
│ Windows │ 192    │ 5,230   │ 2x         │ 10,460       │
├─────────┼────────┼─────────┼────────────┼──────────────┤
│ macOS   │ 30     │ 1,500   │ 10x        │ 15,000       │
└─────────┴────────┴─────────┴────────────┴──────────────┘

💰 Cost Projections (based on GitHub.com pricing):

┌─────────┬──────────────┬───────────┐
│ Period  │ Billable Min │ Est. Cost │
├─────────┼──────────────┼───────────┤
│ Daily   │ 2,262        │ $18.12    │
├─────────┼──────────────┼───────────┤
│ Weekly  │ 15,834       │ $126.84   │
├─────────┼──────────────┼───────────┤
│ Monthly │ 67,860       │ $543.60   │
└─────────┴──────────────┴───────────┘
```

## Custom Label Mappings

Self-hosted runners often have custom labels like `runner-01-prod` or `build-agent-linux`. Use the `--map` flag to specify how these should be categorized:

```bash
gh-forecast --org my-org --map "runner-*:linux,mac-*:macos,win-*:windows"
```

**Format:** `pattern:os,pattern:os`

- Patterns support `*` wildcards
- OS must be one of: `linux`, `windows`, `macos`
- Custom mappings take precedence over default detection

## Billing Multipliers

GitHub Actions bills different runner types at different rates:

| OS | Multiplier | Rate/min |
|----|------------|----------|
| Linux | 1x | $0.008 |
| Windows | 2x | $0.016 |
| macOS | 10x | $0.080 |

> **Note:** These are GitHub.com public rates. Actual GHES costs depend on your enterprise agreement.

## How It Works

1. **Discovery:** Lists all repositories in the target organization
2. **History Extraction:** Fetches completed workflow runs for the specified time period
3. **Job Drill-down:** For each run, fetches job details including runner labels and timing
4. **OS Detection:** Analyzes `runs-on` labels to determine the OS (or uses custom mappings)
5. **Cost Calculation:** Applies GitHub's billing multipliers and rounds up to the nearest minute
6. **Aggregation:** Groups data by OS, repository, workflow, and date
7. **Caching:** Results are cached locally for 30 minutes to speed up subsequent runs

## Caching

Results are cached in `~/.gh-forecast-cache` to avoid redundant API calls:

```bash
# View cache status (shown in header when running)
gh-forecast --org my-org

# Clear cache when you need fresh data
gh-forecast --clear-cache --org my-org

# Disable caching entirely
gh-forecast --org my-org --no-cache

# Custom cache TTL (in minutes)
gh-forecast --org my-org --cache-ttl 60
```

## Development

```bash
# Clone the repo
git clone https://github.com/austenstone/gh-ghes-actions-forecast.git
cd gh-ghes-actions-forecast

# Install dependencies
npm install

# Build
npm run build

# Run locally
node dist/index.js --org my-org

# Or link globally for testing
npm link
gh-forecast --org my-org
```

## Publishing

```bash
# Build and publish to npm
npm publish

# Users can then run with npx
npx gh-forecast --org my-org
```

## License

MIT
