# nlsh — Natural Language Shell for Bash (AI CLI Command Assistant)

[![npm version](https://img.shields.io/npm/v/%40gvibehacker%2Fnlsh.svg)](https://www.npmjs.com/package/@gvibehacker/nlsh)
[![npm downloads](https://img.shields.io/npm/dm/%40gvibehacker%2Fnlsh.svg)](https://www.npmjs.com/package/@gvibehacker/nlsh)

**nlsh** lets you run shell commands with natural language using `//` in your terminal.
It works like an **AI shell copilot** for Bash: describe what you want, review the generated command, then press Enter to run it.

If this project helps you, please ⭐ star the repo on GitHub — it really helps discovery.

---

## Why nlsh?

- ⚡ **Fast command generation** from plain English
- 🧠 **Context-aware** (current directory, OS, and your saved command memory)
- 🔒 **Safer flow**: commands are shown first, then require confirmation
- 💾 **Save useful commands** with `//save` for future prompts
- 🧩 Works as a simple CLI (`nlsh ask "..."`) and as an inline shell workflow (`// ...`)

---

## Demo flow

```bash
// find all .ts files larger than 1MB
# nlsh prints a command
# press Enter to run, any other key to cancel

//save
# saves your last command into memory for better future results
```

---

## Installation

### 1) Install globally from npm

```bash
npm install -g @gvibehacker/nlsh
```

### 2) Log in (set provider/model/API key)

```bash
nlsh login
```

You will be prompted for:

- Provider (default: `google`)
- Model (default: `gemini-3.1-flash-lite-preview`)
- Log retention lines (default: `10000`)
- API key

For Google models, you can create a free API key in Google AI Studio: https://aistudio.google.com/apikey

### 3) Enable shell integration

```bash
nlsh install
source ~/.bash_profile
```

After this, commands beginning with `//` are intercepted by nlsh.

---

## Usage

### Inline mode (recommended)

Use `//` directly in Bash:

```bash
// list the 20 largest files in this project
// create a tar.gz backup of this folder excluding node_modules
// show me open ports and the owning processes
```

### Save useful commands

```bash
//save
```

This stores the last command in `~/.config/nlsh/memory.json` as reusable memory.

### CLI mode

```bash
nlsh ask "find all log files modified in the last 24 hours"
nlsh save "grep -R --line-number TODO src"
```

---

## Commands

```text
nlsh install      Add shell hook to ~/.bash_profile
nlsh uninstall    Remove shell hook from ~/.bash_profile
nlsh login        Save provider/model/api key config
nlsh logout       Remove saved config
nlsh ask <text>   Ask nlsh to generate a shell command
nlsh save <cmd>   Save a command summary into memory
```

---

## How it works

- `nlsh install` injects a small Bash snippet into `~/.bash_profile`.
- The snippet routes `//...` to `nlsh ask ...`.
- nlsh sends prompt context to the model:
  - current working directory
  - OS/platform
  - saved memory entries
- Model returns a single shell command.
- nlsh shows the command and asks for confirmation before execution.

nlsh also logs interactions to:

- `~/.config/nlsh/llm.log`

## Auditability

All LLM interactions are audited locally. Each request/response cycle is logged (including tool-call traces) so you can inspect what was sent and what came back.

- Audit log file: `~/.config/nlsh/llm.log`
- Rotated log file: `~/.config/nlsh/llm.log.1`

Configuration is stored in:

- `~/.config/nlsh/config.json`

Saved command memory is stored in:

- `~/.config/nlsh/memory.json`

---

## Uninstall

```bash
nlsh uninstall
nlsh logout
```

---

## SEO keywords

Natural language shell, AI shell assistant, Bash AI copilot, terminal command generator, CLI productivity, shell command helper, npm CLI tool, developer productivity tool.

---

## Contributing

Issues and PRs are welcome.

If you’d like to help this project grow:

1. Star the GitHub repo ⭐
2. Share it with other terminal-heavy developers
3. Open issues for prompt quality improvements and edge cases

---

## License

ISC
