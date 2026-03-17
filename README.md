# Spelling Coach for Claude Code

A personal spelling coach that runs as a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) `UserPromptSubmit` hook. It automatically detects recurring misspellings in your prompts, tracks them over time, and surfaces memorable mnemonic hints when a pattern emerges.

This is not a spell checker -- it's a **learning tool**. It won't correct every typo. It watches for words you consistently misspell and helps you remember the correct spelling through personalized mnemonics.

## How it works

1. Every prompt you type is spell-checked against the macOS system dictionary
2. Misspellings are tracked with variant grouping (e.g., "infrustructure" and "infastructure" both count toward "infrastructure")
3. After 3 occurrences of the same word, Claude receives a hint via `additionalContext` asking it to generate a memorable mnemonic
4. Claude weaves the hint into its response naturally and saves it for future reference
5. If a mnemonic isn't helping, it rotates to a new approach (up to 3 attempts per word)

## Features

- **Zero dependencies** -- uses macOS `/usr/share/dict/words` with Levenshtein distance
- **~170ms per prompt** -- imperceptible latency
- **Variant grouping** -- different misspellings of the same word count together
- **Smart filtering** -- ignores code blocks, file paths, URLs, CLI flags, camelCase, acronyms, and technical terms
- **Configurable thresholds** -- tune occurrence count, cooldown interval, and time-based gaps
- **Max 1 hint per session** -- helpful, not annoying
- **Mnemonic rotation** -- if a hint doesn't stick, generates a new approach (decomposition, rhyme, visual, acronym, story)
- **Learned words** -- auto-marks words as learned after 30 days without misspelling
- **Fail-open** -- any error outputs `{}` and exits 0, never blocking your prompt
- **Advisory file lock** -- safe with concurrent Claude Code sessions

## Requirements

- macOS (uses `/usr/share/dict/words`)
- Node.js 18+
- Claude Code

## Install

```bash
# Clone to the Claude Code hooks directory
mkdir -p ~/.claude/hooks/spelling-coach
cp spelling-coach.js save-hint.js add-ignore.js stats.js ~/.claude/hooks/spelling-coach/

# Create your custom dictionary (for tech terms, project names, etc.)
cp custom-dictionary.example.txt ~/.claude/hooks/spelling-coach/custom-dictionary.txt
# Edit it to add your own terms

# Register the hook in Claude Code settings
# Add this to ~/.claude/settings.json under the "hooks" key:
```

```json
"UserPromptSubmit": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node ~/.claude/hooks/spelling-coach/spelling-coach.js",
        "timeout": 5
      }
    ]
  }
]
```

## Usage

Once installed, the hook runs automatically on every prompt. No action needed.

### Utility scripts

```bash
# View your spelling stats and tracked words
node ~/.claude/hooks/spelling-coach/stats.js

# Add words to the ignore list (tech terms, proper nouns)
node ~/.claude/hooks/spelling-coach/add-ignore.js kubernetes proxmox

# Temporarily disable (set env var before starting Claude Code)
export SPELLING_COACH_DISABLED=1
```

### How hints appear

When you've misspelled a word 3 times, Claude will naturally mention it in its next response:

> By the way, you've typed "seperate" a few times -- the correct spelling is "separate." A trick to remember: there's A RAT in sep**ARAT**e.

The mnemonic is saved automatically. On the next cooldown (10 more occurrences, minimum 7 days later), Claude will briefly remind you of the hint.

## Configuration

All thresholds are tunable in `data.json` under the `config` key (auto-created on first run):

| Setting | Default | Description |
|---------|---------|-------------|
| `threshold` | 3 | Occurrences before first hint |
| `cooldownInterval` | 10 | Occurrences between hints |
| `minDaysBetweenHints` | 7 | Minimum days before re-showing a hint |
| `maxHintsPerSession` | 1 | Max hints per Claude Code session |
| `maxMnemonics` | 3 | Max mnemonic attempts before giving up on rotation |

## How variant grouping works

Different misspellings of the same word are grouped automatically:

```
"infrustructure" (5x) \
"infastructure"  (2x)  --> "infrastructure" (total: 7)
"infrastrucutre" (1x) /
```

The first time a misspelling is seen, Levenshtein distance finds the closest dictionary word (edit distance <= 2). Subsequent occurrences of the same variant are matched instantly via a cached lookup map.

## Files

| File | Description |
|------|-------------|
| `spelling-coach.js` | Main hook script (~310 lines) |
| `save-hint.js` | Mnemonic persistence (called by Claude) |
| `add-ignore.js` | Add words to ignore list |
| `stats.js` | Print progress summary |
| `custom-dictionary.txt` | Your personal ignore words (gitignored) |
| `custom-dictionary.example.txt` | Template for custom dictionary |
| `data.json` | Tracking data (auto-created, gitignored) |
| `spelling-coach.test.js` | 54 tests using `node --test` |

## Running tests

```bash
node --test spelling-coach.test.js
```

## License

MIT
