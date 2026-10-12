# token-meter

A Claude Code status line: rate limits, context and spend in one row.

```text
5h ▰▰▰▰▱ 82% ↑ high burn till 12:00 │ 7d ▰▰▱▱▱ 41% │ ctx ▰▰▱▱▱ 34% │ api$ 3.13 │ 1d 7.20 │ 30d 452 │ opus 5.5
```

- `5h`, `7d`: used share of the rate-limit windows; $\color{red}\textsf{↑ high burn}$: burning faster than time passes.
- `api$`: session, 1-day and 30-day cost at API prices, not your subscription bill.
- $\color{green}\textsf{< 50}$ / $\color{orange}\textsf{50–79}$ / $\color{red}\textsf{80+}$ %.

## Install

Requires Node 18+ (`brew install node` or [nodejs.org](https://nodejs.org)).

```bash
curl -fsSL https://raw.githubusercontent.com/agukov-dev/token-meter/main/install.sh | sh
```

Or ask Claude to install it from this repo. An existing status line is replaced only after a yes
(from Claude: `… | TOKEN_METER_REPLACE=1 sh`), and the uninstall puts it back.

## Use

- `/token-meter config`: currency (USD or EUR), show or hide the spend.
- `/token-meter update`: update to the latest version.

Only sessions with this status line count toward the spend. The only network request is the ECB
rate, for EUR.

## Remove

```bash
sh ~/.claude/token-meter/app/statusline/uninstall.sh
```
