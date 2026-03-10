# Agent Notes

## nlsh architecture (established)

- `src/index.ts` is the CLI entrypoint and currently owns all behavior (`install`, `uninstall`, `login`, `logout`, `ask`, `save`). No HTTP/server layer is used.
- `src/config.ts` and `src/apiRoute.ts` are intentionally stubbed (`export {}`) from boilerplate; runtime logic is CLI-only.

## Shell interception contract

- `nlsh` installs into `~/.bash_profile` (not `~/.bashrc`) using markers:
  - `# >>> nlsh >>>`
  - `# <<< nlsh <<<`
- Interception is function-based now (no DEBUG trap):
  - `// ...` -> `nlsh ask "..."`
  - `//save` / `// save` -> `nlsh save <previous history command>`
- `NLSH_ACTIVE` guards recursion while `nlsh` runs.
- Install behavior changed: if marker block already exists, `install` replaces/updates that block in place (not just no-op). `uninstall` still removes only the marked block.
- Installed snippet explicitly cleans legacy trap state (`trap - DEBUG`, `unset -f _nlsh_debug_trap`) to prevent double execution in shells that loaded older installs.

## LLM/tooling decisions

- Model toolset now includes `read` + `bash`, both defined inline in `src/index.ts` with TypeBox schemas.
- `bash` is intentionally readonly-constrained (guarded command patterns/tokens; rejects obvious mutating/redirection chains). Keep this restrictive unless you also tighten enforcement elsewhere.
- System prompt remains single-command-only and now explicitly states readonly tools only.
- Prompt context sent on each `ask`: readonly tooling policy, `cwd`, OS (`process.platform`), and serialized `~/.config/nlsh/memory.json`.

## Runtime UX constraints discovered

- Confirmation now uses raw TTY single-key capture: Enter = run, any other key = discard.
- When using raw keypress mode, stdin must be restored and paused in `finally`; otherwise process can appear to hang after command execution.

## Persistence and auth

- Runtime config is stored at `~/.config/nlsh/config.json` with `{provider, model, apiKey, logRetentionLines}`.
- `login` is API-key based (not OAuth) and captures `logRetentionLines` (default `10000`).
- Every LLM interaction is appended to `~/.config/nlsh/llm.log` as JSONL; on retention breach (`>= logRetentionLines`), `llm.log.1` is deleted then `llm.log` is rotated to `llm.log.1` before appending.
- Saved command memory is append-only JSON array at `~/.config/nlsh/memory.json`, entries include `{name, description, command, savedAt}`.

## Notable constraints discovered

- `@mariozechner/pi-agent-core` tool shape requires `label` and a result object including `details`; omitting either fails TS compile.
- `getModel()` provider typing is narrower than runtime input; current code uses a type cast for provider (`config.provider as never`).
