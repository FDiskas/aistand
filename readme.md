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

# Show raw commits
aistand --verbose
```

## Setup

Get API key from [Google AI Studio](https://makersuite.google.com/app/apikey):

```bash
export GEMINI_API_KEY="your-key-here"
```

## Options

```
-v, --version        Show version number
-d, --date <date>    Specify date (YYYY-MM-DD)
-p, --path <path>    Repository path
--verbose            Show raw commits
-k, --api-key <key>  API key
--demo               Demo mode
-h, --help           Show help
```
