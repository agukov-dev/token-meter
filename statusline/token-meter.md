---
description: Settings and updates of the token-meter status line (currency, spend)
argument-hint: "[config | settings | update]"
allowed-tools: Bash(node TOKEN_METER/statusline/statusline.mjs --preview), Bash(curl -fsSL https://raw.githubusercontent.com/agukov-dev/token-meter/main/install.sh | sh), Read(~/.claude/token-meter/config.json), Write(~/.claude/token-meter/config.json), AskUserQuestion
---

Change the settings of the token-meter status line. They live in `~/.claude/token-meter/config.json`:

```json
{ "currency": "USD" | "EUR", "rate": <number, optional: a fixed rate for 1 USD; absent = load the ECB rate>, "showSpend": <bool> }
```

Absent keys mean: `USD`, the loaded rate, `true`. The status line reads the file on every refresh, so nothing needs a restart.

Arguments: `$ARGUMENTS`

If the arguments are `update`, run `curl -fsSL https://raw.githubusercontent.com/agukov-dev/token-meter/main/install.sh | sh`, report its last line, then run the preview of step 5 (the new code). Change no settings, and stop there.

1. Read the current file (it may not exist yet).
2. Unless the arguments are `config` or `settings`, change nothing: run the preview of step 5, list the current settings in one line, and say that `/token-meter config` changes them and `/token-meter update` updates the code. Stop there.
3. Ask with one AskUserQuestion call holding two questions, each option marked "(current)" where it matches the file:
   - **Currency**: `USD`, `EUR, ECB rate` (loaded daily), `EUR, fixed rate` (then ask for the rate as a number in a follow-up).
   - **Spend**: `Show` / `Hide` the cost figures (hide before a screen share; they are still counted).
4. Write the whole file with the result. Drop `rate` unless a fixed rate was chosen.
5. Run `node TOKEN_METER/statusline/statusline.mjs --preview` and show its output in a code block as the preview, then one line on what changed.
