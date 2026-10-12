// token-meter as a Claude Code statusLine command: reads the session JSON on stdin, prints one row.
// Plain JavaScript, so that it runs on Node 18 and later without a build step.
// Usage: node statusline.mjs [--no-spend] [--currency=EUR] [--rate=0.92]
// The settings live in ~/.claude/token-meter/config.json (the /token-meter command writes it); the flags override it.
// `node statusline.mjs --preview` prints the row for sample figures.
// `node statusline.mjs --refresh` is the background job that loads the plan, the rate and the history.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ used_percentage: number, resets_at?: number }} Limit
 * @typedef {{
 *   session_id: string,
 *   model?: { id?: string, display_name?: string },
 *   cost?: { total_cost_usd?: number },
 *   context_window?: { used_percentage?: number | null },
 *   rate_limits?: Partial<Record<'five_hour' | 'seven_day' | 'spend_limit', Limit>>,
 * }} Input
 * @typedef {{ showSpend: boolean, currency: 'USD' | 'EUR', rate?: number }} Settings
 * @typedef {{ today: number, month: number, since?: string, hasUnpriced: boolean }} Spend
 * @typedef {{ name: string, isSubscription: boolean }} Plan
 * @typedef {{ days: Record<string, number>, lastUSD: number, updatedAt: number }} Ledger
 * @typedef {{ days: Record<string, number>, unpriced: string[], isUnavailable?: boolean }} Backfill
 * @typedef {{ rate: number, date: string, fetchedAt: number }} Rate
 * @typedef {{ installedAt: number, refreshStartedAt?: number }} Meta
 */

const DAY_MS = 24 * 3600 * 1000
const SPEND_DAYS = 30
const LEDGER_KEEP_MS = 35 * DAY_MS
const PLAN_MAX_AGE_MS = DAY_MS
const RATE_MAX_AGE_MS = 12 * 3600 * 1000
// A refresh job that has not finished in this time is taken as dead.
const REFRESH_LOCK_MS = 3 * 60 * 1000
const PACE_WARNING = 5
const BAR_WIDTH = 5
const RATE_URL = 'https://api.frankfurter.dev/v1/latest'

const PLAN_TITLES = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }
const LIMIT_TITLES = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const WINDOW_MS = { five_hour: 5 * 3600 * 1000, seven_day: 7 * DAY_MS }
const CURRENCY_SIGNS = { USD: '$', EUR: '€' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const ROOT = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'token-meter')
const LEDGER_DIR = join(ROOT, 'ledger')
const FILES = {
  meta: join(ROOT, 'meta.json'),
  config: join(ROOT, 'config.json'),
  plan: join(ROOT, 'plan.json'),
  backfill: join(ROOT, 'backfill.json'),
  rate: (currency) => join(ROOT, `rate-${currency}.json`),
}

const SCRIPT = fileURLToPath(import.meta.url)

// Claude Code keeps the theme in ~/.claude.json; a regex avoids parsing the whole file on every row.
const theme = (() => {
  try {
    const config = readFileSync(join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json'), 'utf8')

    return /"theme"\s*:\s*"([^"]+)"/.exec(config)?.[1] ?? 'dark'
  } catch {
    return 'dark'
  }
})()

// The secondary text color of the theme, the one of the mode hint under the prompt. SGR 2 (dim) is too faint.
const SECONDARY = theme.endsWith('-ansi') ? '\x1b[90m' : theme.startsWith('light') ? '\x1b[38;2;102;102;102m' : '\x1b[38;2;153;153;153m'

const ansi = {
  dim: (s) => `${SECONDARY}${s}\x1b[39m`,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const pad = (n) => String(n).padStart(2, '0')

const dayKey = (ms) => {
  const at = new Date(ms)

  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

const shortDate = (key) => {
  const [, month = '1', day = '1'] = key.split('-')

  return `${MONTHS[Number(month) - 1]} ${Number(day)}`
}

const money = (amount) =>
  amount >= 10_000 ? `${(amount / 1000).toFixed(1)}k` : amount >= 100 ? String(Math.round(amount)) : amount.toFixed(2)

const resetLabel = (resetsAt, now) => {
  if (!resetsAt) {
    return ''
  }
  const at = new Date(resetsAt * 1000)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`

  return at.getTime() - now < DAY_MS ? time : `${WEEKDAYS[at.getDay()]} ${time}`
}

const limitColor = (percent) => (percent >= 80 ? ansi.red : percent >= 50 ? ansi.yellow : ansi.green)

// Positive: the window burns faster than time passes.
export const pace = (kind, limit, now) => {
  const length = WINDOW_MS[kind]
  if (!length || !limit.resets_at) {
    return undefined
  }
  const elapsed = 1 - (limit.resets_at * 1000 - now) / length
  if (elapsed <= 0.02) {
    return undefined
  }

  return Math.round(limit.used_percentage - elapsed * 100)
}

// claude-opus-5-5[1m] -> opus 5.5; a dated id loses the date.
const shortModel = (model) =>
  model
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-/g, ' ')

const bar = (percent, width) => {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))

  return limitColor(percent)('▰'.repeat(filled)) + ansi.dim('▱'.repeat(width - filled))
}

const sumDays = (days, from, to) =>
  Object.entries(days).reduce((sum, [day, usd]) => (day >= from && day <= to ? sum + usd : sum), 0)

export const parseArgs = (args, config = {}) => {
  const value = (name) => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1]
  const currency = (value('currency') ?? config.currency)?.toUpperCase() === 'EUR' ? 'EUR' : 'USD'
  const rate = Number(value('rate') ?? config.rate)

  return {
    showSpend: !args.includes('--no-spend') && config.showSpend !== false,
    currency,
    rate: currency !== 'USD' && rate > 0 ? rate : undefined,
  }
}

// Adds the growth of the session cost to today; a cleared session starts its cost over from zero.
export const nextLedger = (ledger, usd, now) => {
  const before = ledger ?? { days: {}, lastUSD: usd, updatedAt: now }
  const delta = usd >= before.lastUSD ? usd - before.lastUSD : usd
  const day = dayKey(now)

  return {
    days: delta > 0 ? { ...before.days, [day]: (before.days[day] ?? 0) + delta } : before.days,
    lastUSD: usd,
    updatedAt: now,
  }
}

function recordSessionCost(sessionId, usd, now) {
  const path = join(LEDGER_DIR, `${sessionId.replace(/[^\w-]/g, '_')}.json`)
  const before = readJson(path)
  const next = nextLedger(before, usd, now)
  if (!before || next.lastUSD !== before.lastUSD) {
    writeJson(path, next)
  }
}

function totals(now, meta) {
  const today = dayKey(now)
  const from = dayKey(now - (SPEND_DAYS - 1) * DAY_MS)
  const backfill = readJson(FILES.backfill)
  let spend = { today: 0, month: 0 }
  const add = (days) => {
    spend = { today: spend.today + sumDays(days, today, today), month: spend.month + sumDays(days, from, today) }
  }
  if (backfill) {
    add(backfill.days)
  }
  let names = []
  try {
    names = readdirSync(LEDGER_DIR)
  } catch {
    // No ledger yet.
  }
  for (const name of names) {
    const ledger = readJson(join(LEDGER_DIR, name))
    if (ledger) {
      add(ledger.days)
    }
  }
  const firstDay = backfill && !backfill.isUnavailable ? undefined : dayKey(meta.installedAt)

  return { ...spend, since: firstDay && firstDay > from ? firstDay : undefined, hasUnpriced: (backfill?.unpriced.length ?? 0) > 0 }
}

export function render(input, settings, figures) {
  const { spend, plan, now } = figures
  const isApiAccount = plan !== undefined && !plan.isSubscription
  const sign = CURRENCY_SIGNS[settings.rate ? settings.currency : 'USD']
  const costLabel = `${isApiAccount ? '' : 'api'}${sign}`
  const rate = settings.rate ?? 1
  const cash = (usd) => money(usd * rate)
  const limits = isApiAccount
    ? []
    : ['five_hour', 'seven_day', 'spend_limit'].flatMap(kind => {
        const limit = input.rate_limits?.[kind]

        return limit ? [{ kind, limit }] : []
      })
  const isAhead = (kind, limit) => {
    const ahead = pace(kind, limit, now)

    return ahead !== undefined && ahead > PACE_WARNING
  }
  const gauge = (label, percent, suffix, isWarned = false) =>
    ansi.dim(`${label} `) +
    bar(percent, BAR_WIDTH) +
    ' ' +
    ansi.bold(limitColor(percent)(`${Math.round(percent)}%`)) +
    (isWarned ? ansi.bold(ansi.red(' ↑ high burn')) : '') +
    ansi.dim(suffix)
  const spendPart =
    ansi.dim(`${costLabel} `) +
    ansi.bold(cash(input.cost?.total_cost_usd ?? 0)) +
    ansi.dim(' │ 1d ') +
    ansi.bold(cash(spend.today)) +
    ansi.dim(' │ 30d ') +
    ansi.bold(cash(spend.month)) +
    (spend.hasUnpriced ? ansi.yellow('+?') : '') +
    (spend.since ? ansi.dim(` since ${shortDate(spend.since)}`) : '')

  return [
    limits.length === 0 && !isApiAccount ? ansi.dim('limits after the first reply') : '',
    ...limits.map(({ kind, limit }) =>
      gauge(
        LIMIT_TITLES[kind],
        limit.used_percentage,
        // The weekly reset is days away; one row has no room for it.
        limit.resets_at && kind !== 'seven_day' ? ` till ${resetLabel(limit.resets_at, now)}` : '',
        isAhead(kind, limit),
      ),
    ),
    gauge('ctx', input.context_window?.used_percentage ?? 0, ''),
    settings.showSpend ? spendPart : '',
    // The plan only tells an API account apart; it is not shown.
    input.model?.id ? ansi.dim(shortModel(input.model.id)) : '',
  ]
    .filter(Boolean)
    .join(ansi.dim(' │ '))
}

const isStale = (path, maxAgeMs, now) => {
  try {
    return now - statSync(path).mtimeMs > maxAgeMs
  } catch {
    return true
  }
}

// Starts the background job when the plan, the rate or the history is missing or old.
function scheduleRefresh(meta, settings, now) {
  const isNeeded =
    isStale(FILES.plan, PLAN_MAX_AGE_MS, now) ||
    readJson(FILES.backfill) === undefined ||
    (settings.currency !== 'USD' && settings.rate === undefined && isStale(FILES.rate(settings.currency), RATE_MAX_AGE_MS, now))
  if (!isNeeded || now - (meta.refreshStartedAt ?? 0) < REFRESH_LOCK_MS) {
    return
  }
  writeJson(FILES.meta, { ...meta, refreshStartedAt: now })
  spawn(process.execPath, [SCRIPT, '--refresh', `--currency=${settings.currency}`], { detached: true, stdio: 'ignore' }).unref()
}

async function refresh(settings) {
  const now = Date.now()
  const meta = readJson(FILES.meta) ?? { installedAt: now }
  if (isStale(FILES.plan, PLAN_MAX_AGE_MS, now)) {
    const run = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15_000 })
    if (run.status === 0) {
      const status = JSON.parse(run.stdout)
      const plan = status.subscriptionType
        ? { name: PLAN_TITLES[status.subscriptionType] ?? status.subscriptionType, isSubscription: true }
        : { name: 'API', isSubscription: false }
      writeJson(FILES.plan, plan)
    }
  }
  if (readJson(FILES.backfill) === undefined) {
    const script = join(dirname(SCRIPT), '..', 'scripts', 'backfill.py')
    const run = spawnSync('python3', ['-I', script, homedir(), String(meta.installedAt)], { encoding: 'utf8', timeout: 120_000 })
    const backfill = run.status === 0 ? JSON.parse(run.stdout) : { days: {}, unpriced: [], isUnavailable: true }
    writeJson(FILES.backfill, backfill)
  }
  if (settings.currency !== 'USD' && isStale(FILES.rate(settings.currency), RATE_MAX_AGE_MS, now)) {
    try {
      const response = await fetch(`${RATE_URL}?base=USD&symbols=${settings.currency}`)
      const body = await response.json()
      const rate = body.rates?.[settings.currency]
      if (response.ok && typeof rate === 'number' && rate > 0 && body.date) {
        writeJson(FILES.rate(settings.currency), { rate, date: body.date, fetchedAt: now })
      }
    } catch {
      // No network: the last loaded rate stays.
    }
  }
  try {
    for (const name of readdirSync(LEDGER_DIR)) {
      const path = join(LEDGER_DIR, name)
      if (now - statSync(path).mtimeMs > LEDGER_KEEP_MS) {
        rmSync(path)
      }
    }
  } catch {
    // No ledger yet.
  }
  writeJson(FILES.meta, { installedAt: meta.installedAt })
}

async function main() {
  const settings = parseArgs(process.argv.slice(2), readJson(FILES.config))
  if (process.argv.includes('--refresh')) {
    await refresh(settings)

    return
  }
  const now = Date.now()
  if (process.argv.includes('--preview')) {
    const rate = settings.rate ?? readJson(FILES.rate(settings.currency))?.rate
    const sample = {
      session_id: 'preview',
      model: { id: 'claude-opus-5-5' },
      cost: { total_cost_usd: 3.13 },
      context_window: { used_percentage: 34 },
      rate_limits: {
        five_hour: { used_percentage: 82, resets_at: Math.round(now / 1000) + 3600 },
        seven_day: { used_percentage: 41, resets_at: Math.round(now / 1000) + 3 * 86400 },
      },
    }
    const spend = { today: 7.2, month: 452, hasUnpriced: false }
    const row = render(sample, settings.currency === 'USD' ? settings : { ...settings, rate }, { spend, now })
    // Plain text: the preview is shown in a chat, not a terminal.
    process.stdout.write(`${row.replace(/\x1b\[[\d;]*m/g, '')}\n`)

    return
  }
  let stdin = ''
  for await (const chunk of process.stdin) {
    stdin += chunk
  }
  const input = JSON.parse(stdin)
  let meta = readJson(FILES.meta)
  if (!meta) {
    meta = { installedAt: now }
    writeJson(FILES.meta, meta)
  }
  recordSessionCost(input.session_id, input.cost?.total_cost_usd ?? 0, now)
  scheduleRefresh(meta, settings, now)
  // An auto rate shows dollars until the first one loads.
  const loaded = settings.currency !== 'USD' && settings.rate === undefined ? readJson(FILES.rate(settings.currency)) : undefined
  const shown = loaded ? { ...settings, rate: loaded.rate } : settings
  const row = render(input, shown, { spend: totals(now, meta), plan: readJson(FILES.plan), now })
  process.stdout.write(`${row}\n`)
}

if (process.argv[1] === SCRIPT) {
  await main()
}
