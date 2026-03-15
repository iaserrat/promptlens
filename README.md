# promptlens

Your prompting habits, visualized. A Claude Code hook + terminal dashboard (TUI) that scores, categorizes, and tracks every prompt you send — helping you spot patterns and level up.

## How it works

promptlens has two parts that work together:

1. **Hook** (`hook.ts`) — A Claude Code `UserPromptSubmit` hook that runs silently in the background. For each prompt over a configurable minimum length, it sends the text to a fast/cheap LLM via OpenRouter, which returns a category, complexity rating, quality score (1-10), and a brief insight. Results are stored locally in `promptlens.db`. Duplicate prompts are automatically skipped via content hashing, and attached images (screenshots, diagrams) are detected and factored into the analysis.

2. **TUI** (`tui.tsx`) — A full-screen terminal dashboard built with [Ink](https://github.com/vadimdemedes/ink) that live-polls the database every 1.5s. Three tabs:
   - **Dashboard** — Scrollable table of analyses, score distributions, per-project breakdowns, complexity charts, and session grouping.
   - **Trends** — Quality score and prompt volume over time, category breakdown charts.
   - **Tips** — Actionable recommendations to improve your prompting. Shows score-by-category charts, week-over-week scorecard, prompt length vs quality correlation, SQL-derived pattern detection, and AI-powered insights (on-demand LLM analysis of your aggregate patterns, cached until new data arrives).

3. **Import** (`import.ts`) — Bulk-import and analyze your existing Claude Code history (`~/.claude/history.jsonl`). Deduplicates against already-analyzed prompts, supports concurrency control, and shows real-time cost tracking.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- An [OpenRouter](https://openrouter.ai) API key

### Install

```bash
git clone https://github.com/iaserrat/promptlens ~/.claude/hooks/promptlens
cd ~/.claude/hooks/promptlens
bun install
bun link    # makes `promptlens` available globally
```

### Configure

Copy the example env file and add your key:

```bash
cp .env.example .env
```

```env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-haiku-4.5   # optional, this is the default
PROMPTLENS_MIN_LENGTH=50                       # optional, minimum prompt length to analyze
```

### Register the hook

Add this to your Claude Code hooks config (`~/.claude/settings.json` or project-level):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun --env-file=$HOME/.claude/hooks/promptlens/.env run $HOME/.claude/hooks/promptlens/hook.ts",
            "async": true
          }
        ]
      }
    ]
  }
}
```

## Usage

### Dashboard

```bash
promptlens
# or: bun run tui
```

### Import history

```bash
promptlens import              # import and analyze all history
promptlens import --dry-run    # preview counts and estimated cost
promptlens import --project=/path/to/repo  # filter by project
promptlens import --concurrency=10         # parallel requests (default: 5)
```

### Keyboard shortcuts

| Key         | Action                  |
| ----------- | ----------------------- |
| `↑/k` `↓/j` | Navigate entries        |
| `p`         | Cycle project filter    |
| `c`         | Cycle category filter   |
| `f`         | Cycle session filter    |
| `g`         | Toggle session grouping |
| `Tab`       | Switch tab (Dashboard/Trends/Tips) |
| `[`/`]`     | Scroll sidebar panels   |
| `Esc`       | Clear all filters       |
| `d`         | Delete selected entry   |
| `D`         | Delete all entries      |
| `r`         | Force refresh           |
| `?`         | Toggle help overlay     |
| `q`         | Quit                    |

## Categories

Prompts are classified into: `feature`, `debug`, `refactor`, `explain`, `config`, `test`, `docs`, `other`

## Stack

- **Runtime:** Bun
- **Database:** SQLite (via `bun:sqlite`)
- **LLM:** Any OpenRouter-compatible model
- **TUI:** React + Ink

## License

[MIT](LICENSE)
