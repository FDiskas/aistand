# aistand

A CLI tool to summarize your Git commits for daily stand-ups using AI.

## Install

```bash
npm install -g aistand
```

## Usage

```bash
# Basic usage
aistand

# Demo mode (no API key)
aistand --demo

# Specific date
aistand --date 2024-01-15

# Force a particular Gemini model
aistand --model gemini-1.5-flash

# Scan the 5 most recent branches in addition to the current one
aistand --recent-branches 5

# Show raw commits
aistand --verbose
```

## Setup

Get an API key from [Google AI Studio](https://aistudio.google.com/apikey):

```bash
export GEMINI_API_KEY="your-key-here"
# or use the SDK's default env variable
export GOOGLE_API_KEY="your-key-here"

# Optional: choose a default model supported by your quota
export GEMINI_MODEL="gemini-1.5-flash"

# Optional: change how many branches are scanned (default is 3)
export AISTAND_RECENT_BRANCHES=5
```

By default the CLI now queries the Gemini API (via `@google/genai`) for the latest flash-capable models and automatically tries the best production-ready one your key can access (experimental/preview variants are skipped). Override this by passing `--model` or setting `GEMINI_MODEL`.

## Options

```
-v, --version        Show version number
-d, --date <date>    Specify date (YYYY-MM-DD)
-p, --path <path>    Repository path
--verbose            Show raw commits
-k, --api-key <key>  API key (or set GEMINI_API_KEY / GOOGLE_API_KEY)
--recent-branches <count>
					  Also scan N most recently updated local branches (default 3, use 0 to disable)
--model <name>       Override Gemini model (or set GEMINI_MODEL)
--demo               Demo mode
-h, --help           Show help
```
