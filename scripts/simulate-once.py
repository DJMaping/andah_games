#!/usr/bin/env python3
"""One-shot World Cup simulation matching world-cup.html logic. Outputs results to a text file."""
import json, random, math, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / 'andah-fifa-data.js'
OUT_PATH = ROOT / 'simulation-result.txt'

# ── Load data ──
content = DATA_PATH.read_text(encoding='utf-8')
json_str = re.search(r'=\s*(\[.*\])\s*;', content, re.DOTALL).group(1)
all_teams = json.loads(json_str)
rank_lookup = {t['name']: t['rank'] for t in all_teams}

# ── Math helpers ──
def win_prob(a, b):
    return 1 / (1 + 10 ** (-(a - b) / 400))

def poisson(lam):
    L = math.exp(-min(lam, 20))
    k, p = 0, 1
    while True:
        k += 1
        p *= random.random()
        if p <= L:
            break
    return k - 1

# ── Match sims ──
def gen_goals(outcome, ra, rb):
    base, factor = 1.25, 0.002
    if outcome == 'draw':
        g = poisson(base * 0.85)
        return {'gA': g, 'gB': g, 'outcome': 'draw', 'resolution': 'fulltime'}
    wr = ra if outcome == 'A' else rb
    lr = rb if outcome == 'A' else ra
    rd = wr - lr
    wL = max(0.6, base + rd * factor)
    lL = max(0.25, base - rd * factor * 0.5)
    wg = poisson(wL)
    lg = poisson(lL)
    if wg <= lg:
        wg = lg + 1
    gA = wg if outcome == 'A' else lg
    gB = lg if outcome == 'A' else wg
    return {'gA': gA, 'gB': gB, 'outcome': outcome, 'resolution': 'fulltime'}

def sim_group_match(a, b):
    pA = win_prob(a['adjustedPoints'], b['adjustedPoints'])
    draw_p = 0.26
    adj = pA * (1 - draw_p)
    r = random.random()
    if r < adj: out = 'A'
    elif r < adj + draw_p: out = 'draw'
    else: out = 'B'
    return gen_goals(out, a['adjustedPoints'], b['adjustedPoints'])

def sim_penalties(pA):
    convA = 0.75 + (pA - 0.5) * 0.04
    convB = 0.75 - (pA - 0.5) * 0.04
    penA = penB = 0
    for i in range(5):
        if random.random() < convA: penA += 1
        if random.random() < convB: penB += 1
    while penA == penB:
        if random.random() < convA: penA += 1
        if random.random() < convB: penB += 1
        if penA != penB: break
    return penA, penB

def sim_ko_match(a, b):
    pA = win_prob(a['adjustedPoints'], b['adjustedPoints'])
    draw_p = 0.22
    adj = pA * (1 - draw_p)
    r = random.random()
    if r < adj:
        return gen_goals('A', a['adjustedPoints'], b['adjustedPoints'])
    if r >= adj + draw_p:
        return gen_goals('B', a['adjustedPoints'], b['adjustedPoints'])
    # Extra time
    draw_goals = poisson(1.25 * 0.85)
    if random.random() < 0.45:
        et_winner = 'A' if random.random() < pA else 'B'
        extra = draw_goals + 1
        return {'gA': extra if et_winner == 'A' else draw_goals,
                'gB': extra if et_winner == 'B' else draw_goals,
                'outcome': et_winner, 'resolution': 'extratime'}
    penA, penB = sim_penalties(pA)
    return {'gA': draw_goals, 'gB': draw_goals, 'penA': penA, 'penB': penB,
            'outcome': 'A' if penA > penB else 'B', 'resolution': 'penalties'}

# ── Group stage logic ──
def sim_group_stage(teams):
    table = [{'team': t, 'p': 0, 'w': 0, 'd': 0, 'l': 0, 'gf': 0, 'ga': 0, 'pts': 0} for t in teams]
    matches = []
    for i in range(len(teams)):
        for j in range(i + 1, len(teams)):
            res = sim_group_match(teams[i], teams[j])
            matches.append({'home': teams[i], 'away': teams[j], **res})
            ri = next(r for r in table if r['team'] is teams[i])
            rj = next(r for r in table if r['team'] is teams[j])
            ri['p'] += 1; rj['p'] += 1
            ri['gf'] += res['gA']; ri['ga'] += res['gB']
            rj['gf'] += res['gB']; rj['ga'] += res['gA']
            if res['outcome'] == 'draw':
                ri['d'] += 1; rj['d'] += 1
                ri['pts'] += 1; rj['pts'] += 1
            elif res['outcome'] == 'A':
                ri['w'] += 1; rj['l'] += 1; ri['pts'] += 3
            else:
                rj['w'] += 1; ri['l'] += 1; rj['pts'] += 3
    table.sort(key=lambda r: (-r['pts'], -(r['gf'] - r['ga']), -r['gf'], random.random()))
    return table, matches

# ── Qualifier slot allocation ──
def allocate_slots(continents, total):
    total_c = sum(continents.values())
    raw = [{'name': k, 'count': v, 'exact': (v / total_c) * total,
            'floor': max(1, int((v / total_c) * total))} for k, v in continents.items()]
    assigned = sum(r['floor'] for r in raw)
    remaining = total - assigned
    raw.sort(key=lambda r: -(r['exact'] - r['floor']))
    for i in range(min(remaining, len(raw))):
        raw[i]['floor'] += 1
    return {r['name']: r['floor'] for r in raw}

# ── Qualifiers ──
def run_qualifiers():
    by_cont = {}
    for t in all_teams:
        c = t['continent'].split('/')[0] if '/' in t['continent'] else t['continent']
        by_cont.setdefault(c, []).append({**t, 'qualContinent': c})
    cont_counts = {k: len(v) for k, v in by_cont.items()}
    slots = allocate_slots(cont_counts, 32)
    qualifiers = []
    qual_data = []
    for cont, teams in by_cont.items():
        n = slots[cont]
        sorted_t = sorted(teams, key=lambda t: -t['adjustedPoints'])
        if len(sorted_t) <= n:
            qualifiers.extend(sorted_t)
            qual_data.append({'continent': cont, 'slots': n, 'direct': True,
                              'qualified': [t['name'] for t in sorted_t], 'groups': []})
            continue
        n_groups = max(1, math.ceil(len(sorted_t) / 4))
        groups = [[] for _ in range(n_groups)]
        for i, t in enumerate(sorted_t):
            groups[i % n_groups].append(t)
        qual_per = n // n_groups
        extra = n - qual_per * n_groups
        cont_qual = []
        group_results = []
        for g in groups:
            table, matches = sim_group_stage(g)
            n_qual = qual_per + (1 if extra > 0 else 0)
            if extra > 0: extra -= 1
            for i in range(min(n_qual, len(table))):
                cont_qual.append(table[i]['team'])
            group_results.append({'table': table, 'matches': matches, 'n_qual': n_qual})
        qualifiers.extend(cont_qual)
        qual_data.append({'continent': cont, 'slots': n, 'direct': False,
                          'qualified': [t['name'] for t in cont_qual], 'groups': group_results})
    return qualifiers, qual_data

# ── Group draw ──
def draw_groups(qualifiers):
    sorted_q = sorted(qualifiers, key=lambda t: -t['adjustedPoints'])
    pots = [sorted_q[i*8:(i+1)*8] for i in range(4)]
    for attempt in range(100):
        groups = [[] for _ in range(8)]
        valid = True
        for pot in pots:
            pot_copy = pot[:]
            random.shuffle(pot_copy)
            for gi, team in enumerate(pot_copy):
                conts = [t.get('qualContinent', t['continent']) for t in groups[gi]]
                if team.get('qualContinent', team['continent']) in conts:
                    valid = False
                    break
                groups[gi].append(team)
            if not valid: break
        if valid: return groups
    groups = [[] for _ in range(8)]
    for pot in pots:
        random.shuffle(pot)
        for gi in range(8):
            groups[gi].append(pot[gi])
    return groups

# ── Run tournament ──
goal_tally = {}
upsets = []

def track_goals(team, g):
    goal_tally[team['name']] = goal_tally.get(team['name'], 0) + g

def track_upset(w, l, rd, res):
    diff = l['adjustedPoints'] - w['adjustedPoints']
    if diff >= 150:
        score = f"{res['gA']}-{res['gB']}"
        if res['resolution'] == 'penalties':
            score += f" ({res['penA']}-{res['penB']} pen.)"
        elif res['resolution'] == 'extratime':
            score += ' (a.e.t.)'
        upsets.append({'winner': w['name'], 'loser': l['name'],
                       'diff': round(diff), 'round': rd, 'score': score})

qualifiers, qual_data = run_qualifiers()
groups = draw_groups(qualifiers)
group_labels = 'ABCDEFGH'
group_results = []
for gi, g in enumerate(groups):
    table, matches = sim_group_stage(g)
    group_results.append({'label': group_labels[gi], 'table': table, 'matches': matches})
    for m in matches:
        track_goals(m['home'], m['gA'])
        track_goals(m['away'], m['gB'])
        if m['outcome'] == 'A':
            track_upset(m['home'], m['away'], f"Group {group_labels[gi]}", m)
        elif m['outcome'] == 'B':
            track_upset(m['away'], m['home'], f"Group {group_labels[gi]}", m)

# R16 matchups
r16_pairs = [(0, 0, 1, 1), (2, 0, 3, 1), (4, 0, 5, 1), (6, 0, 7, 1),
             (1, 0, 0, 1), (3, 0, 2, 1), (5, 0, 4, 1), (7, 0, 6, 1)]
r16 = []
for ga, ra, gb, rb in r16_pairs:
    r16.append({'teamA': group_results[ga]['table'][ra]['team'],
                'teamB': group_results[gb]['table'][rb]['team']})

def resolve(match, round_name):
    a, b = match['teamA'], match['teamB']
    res = sim_ko_match(a, b)
    match['result'] = res
    track_goals(a, res['gA'])
    track_goals(b, res['gB'])
    winner = a if res['outcome'] == 'A' else b
    loser = b if res['outcome'] == 'A' else a
    match['winner'] = winner
    match['loser'] = loser
    track_upset(winner, loser, round_name, res)

for m in r16: resolve(m, 'Round of 16')

qf = [{'teamA': r16[0]['winner'], 'teamB': r16[1]['winner']},
      {'teamA': r16[2]['winner'], 'teamB': r16[3]['winner']},
      {'teamA': r16[4]['winner'], 'teamB': r16[5]['winner']},
      {'teamA': r16[6]['winner'], 'teamB': r16[7]['winner']}]
for m in qf: resolve(m, 'Quarter-Final')

sf = [{'teamA': qf[0]['winner'], 'teamB': qf[1]['winner']},
      {'teamA': qf[2]['winner'], 'teamB': qf[3]['winner']}]
for m in sf: resolve(m, 'Semi-Final')

third = {'teamA': sf[0]['loser'], 'teamB': sf[1]['loser']}
resolve(third, '3rd Place')

final = {'teamA': sf[0]['winner'], 'teamB': sf[1]['winner']}
resolve(final, 'Final')

# ── Output ──
def fmt_score(r):
    s = f"{r['gA']}-{r['gB']}"
    if r['resolution'] == 'extratime': s += ' (a.e.t.)'
    if r['resolution'] == 'penalties': s += f" ({r['penA']}-{r['penB']} pen.)"
    return s

lines = []
lines.append('═' * 70)
lines.append('   1764 ANDAH WORLD CUP — SIMULATION RESULT')
lines.append('═' * 70)
lines.append('')

# Champion
champ = final['winner']
ru = final['loser']
t3 = third['winner']
t4 = third['loser']
lines.append('🏆 CHAMPION: ' + champ['name'] + f"  (FLLA #{champ['rank']})")
lines.append(f"   Final: {final['teamA']['name']} {fmt_score(final['result'])} {final['teamB']['name']}")
lines.append('')
lines.append('Podium:')
lines.append(f"   🥇 {champ['name']}  (FLLA #{champ['rank']})")
lines.append(f"   🥈 {ru['name']}  (FLLA #{ru['rank']})")
lines.append(f"   🥉 {t3['name']}  (FLLA #{t3['rank']})")
lines.append(f"   4. {t4['name']}  (FLLA #{t4['rank']})")
lines.append('')

# Golden Boot
top_scorers = sorted(goal_tally.items(), key=lambda x: -x[1])
gb = top_scorers[0]
lines.append(f"⚽ Golden Boot: {gb[0]}  ({gb[1]} goals, FLLA #{rank_lookup.get(gb[0], '?')})")
lines.append('')

# Biggest upset
if upsets:
    big = sorted(upsets, key=lambda u: -u['diff'])[0]
    lines.append(f"💥 Biggest Upset: {big['winner']} beat {big['loser']} {big['score']}")
    lines.append(f"   ({big['round']}, {big['diff']} rating gap)")
    lines.append('')

lines.append('─' * 70)
lines.append('CONTINENTAL QUALIFIERS')
lines.append('─' * 70)
for q in qual_data:
    lines.append(f"\n  {q['continent']}  —  {q['slots']} slot(s) allocated")
    if q['direct']:
        lines.append('    All teams qualified directly.')
    qualified_names = ', '.join(q['qualified'])
    lines.append(f"    Qualified: {qualified_names}")

lines.append('')
lines.append('─' * 70)
lines.append('GROUP STAGE')
lines.append('─' * 70)
for gr in group_results:
    lines.append(f"\n  Group {gr['label']}")
    lines.append('    ' + 'Team'.ljust(20) + 'P  W  D  L   GF  GA  GD  Pts')
    for i, r in enumerate(gr['table']):
        mark = '✓ ' if i < 2 else '  '
        nm = r['team']['name'][:18].ljust(20)
        gd = r['gf'] - r['ga']
        gd_s = f"+{gd}" if gd > 0 else str(gd)
        lines.append(f"  {mark}{nm}{r['p']:2} {r['w']:2} {r['d']:2} {r['l']:2}  {r['gf']:3} {r['ga']:3}  {gd_s:>3}  {r['pts']:3}")
    lines.append('    Matches:')
    for m in gr['matches']:
        lines.append(f"      {m['home']['name']:>20} {m['gA']}-{m['gB']} {m['away']['name']}")

lines.append('')
lines.append('─' * 70)
lines.append('KNOCKOUT STAGE')
lines.append('─' * 70)

def fmt_ko(round_name, matches):
    lines.append(f"\n  {round_name}")
    for m in matches:
        a, b = m['teamA'], m['teamB']
        w = m['winner']['name']
        line = f"    {a['name']} {fmt_score(m['result'])} {b['name']}    [{w} wins]"
        lines.append(line)

fmt_ko('Round of 16', r16)
fmt_ko('Quarter-Finals', qf)
fmt_ko('Semi-Finals', sf)
fmt_ko('3rd Place Playoff', [third])
fmt_ko('Final', [final])

lines.append('')
lines.append('─' * 70)
lines.append('TOP SCORERS')
lines.append('─' * 70)
for name, goals in top_scorers[:10]:
    lines.append(f"    {goals:3}  {name}  (FLLA #{rank_lookup.get(name, '?')})")

lines.append('')
lines.append('─' * 70)
lines.append('ALL UPSETS')
lines.append('─' * 70)
if upsets:
    for u in sorted(upsets, key=lambda u: -u['diff']):
        lines.append(f"    {u['winner']} beat {u['loser']} {u['score']}  ({u['round']}, {u['diff']} gap)")
else:
    lines.append('    No major upsets this tournament.')

lines.append('')
lines.append('═' * 70)

OUT_PATH.write_text('\n'.join(lines), encoding='utf-8')
print(f"Wrote results to {OUT_PATH}")
print(f"Champion: {champ['name']} (FLLA #{champ['rank']})")
