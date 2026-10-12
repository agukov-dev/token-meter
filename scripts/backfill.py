"""One-time import of Claude Code spend from local logs, at API list prices.

Usage: python3 -I backfill.py <home> <until_ms>
Prints {"days": {"YYYY-MM-DD": usd}, "unpriced": [model, ...]} for the last
31 days before until_ms, in local time.
"""
import datetime
import glob
import json
import os
import sys

# Per 1M tokens: input, output, cache read. Cache write: 1.25x input (5m), 2x input (1h).
# Fast mode costs 2x the standard rates.
PRICES = {
    'claude-fable-5-1': (10, 50, 0.25), 'claude-fable-5': (10, 50, 1.0),
    'claude-opus-5-5': (4, 20, 0.2), 'claude-opus-5': (5, 25, 0.5),
    'claude-opus-4-8': (5, 25, 0.5), 'claude-opus-4-7': (5, 25, 0.5), 'claude-opus-4-6': (5, 25, 0.5),
    'claude-sonnet-5-5': (2, 10, 0.2), 'claude-sonnet-5': (2, 10, 0.2), 'claude-sonnet-4-6': (3, 15, 0.3),
    'claude-haiku-5-5': (0.1, 0.5, 0.01), 'claude-haiku-4-5': (1, 5, 0.1),
}

home, until_ms = sys.argv[1], int(sys.argv[2])
until = datetime.datetime.fromtimestamp(until_ms / 1000).astimezone()
since = until - datetime.timedelta(days=31)
days, unpriced, seen = {}, set(), set()

for path in glob.glob(os.path.join(home, '.claude/projects/**/*.jsonl'), recursive=True):
    try:
        if os.path.getmtime(path) < since.timestamp():
            continue
        lines = open(path, errors='ignore')
    except OSError:
        continue
    for line in lines:
        if '"usage"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get('message')
        if not isinstance(message, dict) or not message.get('usage') or not entry.get('timestamp'):
            continue
        at = datetime.datetime.fromisoformat(entry['timestamp'].replace('Z', '+00:00')).astimezone()
        if at < since or at >= until:
            continue
        key = (message.get('id'), entry.get('requestId'))
        if key in seen:
            continue
        seen.add(key)
        model = str(message.get('model', '')).split('[')[0]
        if model == '<synthetic>':
            continue
        price = PRICES.get(model)
        if not price:
            unpriced.add(model)
            continue
        usage = message['usage']
        inp, out, read = price
        created = usage.get('cache_creation') or {}
        hour = created.get('ephemeral_1h_input_tokens', 0) or 0
        rest = max((usage.get('cache_creation_input_tokens', 0) or 0) - hour, 0)
        cost = ((usage.get('input_tokens', 0) or 0) * inp + (usage.get('output_tokens', 0) or 0) * out
                + (usage.get('cache_read_input_tokens', 0) or 0) * read + hour * inp * 2 + rest * inp * 1.25) / 1e6
        if usage.get('speed') == 'fast':
            cost *= 2
        day = at.strftime('%Y-%m-%d')
        days[day] = days.get(day, 0.0) + cost

print(json.dumps({'days': days, 'unpriced': sorted(unpriced)}))
