import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
content = (ROOT / 'js' / 'andah-fifa-data.js').read_text(encoding='utf-8')
data = json.loads(re.search(r'=\s*(\[.*\])\s*;', content, re.DOTALL).group(1))

banned = {'Ocaun', 'Shomjind'}
teams = [t for t in data if t['name'] not in banned and t['adjustedPoints'] > 0]

counts = {}
for t in teams:
    c = t['continent'].split('/')[0]
    counts[c] = counts.get(c, 0) + 1

total = sum(counts.values())
print(f'Total teams (after bans): {total}')
print()

raw = []
for name, count in counts.items():
    exact = (count / total) * 32
    floor = max(1, int(exact))
    raw.append({'name': name, 'count': count, 'exact': exact, 'floor': floor, 'frac': exact - int(exact)})

assigned = sum(r['floor'] for r in raw)
remaining = 32 - assigned
raw.sort(key=lambda r: -r['frac'])
for i in range(remaining):
    raw[i]['floor'] += 1

formats = {
    'Ayuma': 'UEFA (Europe)',
    'Mahea': 'UEFA (Europe)',
    'Atirha': 'CONCACAF (N. America)',
    'Massir': 'AFC (Asia)',
    'Quia': 'AFC (Asia)',
    'Acrola': 'CAF (Africa)',
    'New Ayre': 'CONMEBOL (S. America)',
}

raw.sort(key=lambda r: -r['floor'])
print('Continent     Countries  Slots   Format')
print('-' * 60)
for r in raw:
    print(f"{r['name']:<13} {r['count']:<10} {r['floor']:<7} {formats.get(r['name'], '?')}")
print('-' * 60)
print(f"{'TOTAL':<13} {total:<10} {sum(r['floor'] for r in raw):<7}")
