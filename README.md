# promptlens

Your prompting habits, visualized. A Claude Code hook + terminal dashboard (TUI) that scores, categorizes, and tracks every prompt you send — helping you spot patterns and level up.

## How it works

promptlens has two parts that work together:

1. **Hook** (`hook.ts`) — A Claude Code `UserPromptSubmit` hook that runs silently in the background. For each prompt over a configurable minimum length, it sends the text to a fast/cheap LLM via OpenRouter, which returns a category, complexity rating, quality score (1-10), and a brief insight. Results are stored locally in `promptlens.db`. Duplicate prompts are automatically skipped via content hashing, and attached images (screenshots, diagrams) are detected and factored into the analysis.

2. **TUI** (`tui.tsx`) — A full-screen terminal dashboard built with [Ink](https://github.com/vadimdemedes/ink) that live-polls the database every 1.5s. Shows a scrollable table of analyses, score distributions, per-project breakdowns, complexity charts, and session grouping. Run it anytime with `promptlens`.

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

### Keyboard shortcuts

| Key         | Action                  |
| ----------- | ----------------------- |
| `↑/k` `↓/j` | Navigate entries        |
| `p`         | Cycle project filter    |
| `c`         | Cycle category filter   |
| `f`         | Cycle session filter    |
| `g`         | Toggle session grouping |
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
