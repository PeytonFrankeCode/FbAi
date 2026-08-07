import json, re, collections

def rd(p):
    return [l for l in open(p, encoding='utf-8').read().split('\n') if l.strip()]

base = []
for l in rd('scripts/data/base.txt'):
    n, p, t = l.split('|')
    base.append({'number': n, 'player': p, 'team': t})
by_num = {c['number']: c for c in base}

subsets = {}
lines = rd('scripts/data/subsets.txt')
for i in range(0, len(lines), 2):
    subsets[lines[i][1:]] = lines[i+1].split()

def from_nums(nums, add_rookies=True):
    out = []
    for n in nums:
        out.append(dict(by_num[n]))
    if add_rookies:
        for n in range(301, 401):
            out.append(dict(by_num[str(n)]))
    return out

# Coded sets
coded = collections.OrderedDict()
cur = None
for l in rd('scripts/data/coded.txt'):
    if l.startswith('== '):
        name, cat, pr, notes = l[3:].split('|')
        cur = {'name': name, 'category': cat,
               'printRun': None if pr == '-' else int(pr),
               'notes': notes.strip(), 'cards': []}
        coded[name] = cur
    else:
        n, p, t = l.split('|')
        cur['cards'].append({'number': n, 'player': p, 'team': t})

def P(name, run=None):
    return {'name': name, 'printRun': run}

BASE_PARALLELS = [
    P('Base'), P('Aqua Holo Foil'), P('Aqua Rainbow Foil'), P('Diamante Foil'),
    P('Football'), P('Holo Foil'), P('Pink Diamante Foil'), P('Rainbow Foil'),
    P('Sandglitter'), P('Gold', 2026), P('Pink Holo Foil', 1200), P('Yellow Holo Foil', 399),
    P('Purple Holo Foil', 250), P('Blue Holo Foil', 150), P('Green Diamante Foil', 99),
    P('Green Holo Foil', 99), P('Football Green', 99), P('Green Rainbow Foil', 99),
    P('Independence Day', 76), P('Black', 70), P('Gold Diamante', 50), P('Gold Holo Foil', 50),
    P('Gold Rainbow Foil', 50), P('Football Gold', 50), P('Sandglitter Gold', 50), P('Canvas', 50),
    P('Camo', 25), P('Orange Diamante Foil', 25), P('Orange Holo Foil', 25),
    P('Orange Rainbow Foil', 25), P('Football Orange', 25), P('Sandglitter Orange', 25),
    P('Black Diamante Foil', 10), P('Black Holo Foil', 10), P('Black Rainbow Foil', 10),
    P('Football Black', 10), P('Sandglitter Black', 10), P('Red Diamante Foil', 5),
    P('Red Holo Foil', 5), P('Red Rainbow Foil', 5), P('Football Red', 5), P('Sandglitter Red', 5),
    P('Foilfractor', 1), P('Football Rose Gold', 1), P('Rose Gold Holo Foil', 1),
]
AUTO_PARALLELS = [P('Green', 99), P('Gold', 50), P('Orange', 25), P('Black', 10), P('Red', 5), P('Foilfractor', 1)]
AUTO_BLUE = [P('Blue', 150)] + AUTO_PARALLELS
INSERT_PARALLELS = [P('Pink'), P('Blue', 150), P('Green', 99), P('Gold', 50), P('Orange', 25), P('Black', 10), P('Red', 5), P('Foilfractor', 1)]
INSERT_NOPINK = [P('Blue', 150), P('Green', 99), P('Gold', 50), P('Orange', 25), P('Black', 10), P('Red', 5), P('Foilfractor', 1)]
RELIC_AUTO = [P('Gold', 50), P('Orange', 25), P('Black', 10), P('Red', 5), P('Foilfractor', 1)]
PATCH_AUTO = [P('Orange', 25), P('Black', 10), P('Red', 5), P('Foilfractor', 1)]
CRACKLE = [
    P('Crackle Foil'), P('Pink Crackle'), P('Pink', 1000), P('Blue', 150), P('Blue Crackle', 150),
    P('Green', 150), P('Green Crackle', 99), P('The Real One', 91), P('Gold', 50), P('Gold Crackle', 50),
    P('No Name', 35), P('Orange', 25), P('Orange Crackle', 25), P('Black', 10), P('Black Crackle', 10),
    P('Red', 5), P('Red Crackle', 5), P('Foilfractor', 1),
]
CHROME_91 = [P('Purple', 250), P('Aqua', 199), P('Blue', 150), P('Green', 99), P('Gold', 50),
             P('Orange', 25), P('Black', 10), P('Red', 5), P('Superfractor', 1)]
RETAIL = [P('Crackle Foil'), P('Green', 150), P('Gold', 50), P('Gold Crackle', 50), P('Orange', 25),
          P('Orange Crackle', 25), P('Black', 10), P('Black Crackle', 10), P('Red', 5), P('Red Crackle', 5), P('Foilfractor', 1)]

def slug(s):
    s = s.lower().replace('’', '').replace("'", '')
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s)).strip('-')

sets = []
def add(name, category, cards, parallels=None, print_run=None, notes=''):
    s = {'id': slug(name), 'name': name, 'category': category, 'totalCards': len(cards)}
    if print_run is not None: s['printRun'] = print_run
    if notes: s['notes'] = notes
    s['parallels'] = parallels or []
    s['cards'] = cards
    sets.append(s)

# --- Base + variations ---
add('Base Set', 'base', base, BASE_PARALLELS)
add('Base - Golden Mirror Variations', 'base', [dict(c) for c in base])
add('Base - Vintage Stock Variation', 'base', from_nums(subsets['vintage']), print_run=99)
add('Base - Clear Variation', 'base', from_nums(subsets['clear']), print_run=10, notes='Hobby Exclusive')
add('Base - Team Color Border Variation', 'base', from_nums(subsets['teamcolor']))
add('Base - Player Number Variation', 'base', from_nums(subsets['playernumber']), print_run=20, notes='Hobby Exclusive')
add('Base - True Photo Variation', 'base', from_nums(subsets['truephoto']), print_run=100)

def take(name, **kw):
    c = coded[name]
    add(c['name'], c['category'], c['cards'], kw.get('parallels'),
        kw.get('print_run', c['printRun']), kw.get('notes', c['notes']))

take('1957 Rookie Variation')
take('Base - Super Box Oversized')
take('Base - Companion Cards')
take('Base - Funko Pops')

# --- Autographs ---
add('Real One Autographs', 'autograph', from_nums(subsets['realone'], add_rookies=False), AUTO_PARALLELS, 250)
add('Rookie Real One Autographs', 'autograph', from_nums(subsets['rookierealone'], add_rookies=False), AUTO_PARALLELS, 250)
take('Flagship First Signatures')
take('Flagship First Dual Signatures')
take('NFL Stars Autographs', parallels=AUTO_BLUE)
take('NFL Stars Dual Autographs')
take('NFL Stars Triple Autographs')
take('1991 Topps Football Autographs', parallels=AUTO_BLUE)
take('1991 Topps Football Rookie Autographs', parallels=AUTO_BLUE)
take('1991 Super Rookies Autographs', parallels=AUTO_PARALLELS)
take('Victory Ink')
take('Mascot Autographs', parallels=AUTO_PARALLELS)
take('Island Ink', parallels=AUTO_PARALLELS)
take('2025 All Topps Team Autographs', parallels=AUTO_PARALLELS)
take('Super Bowl Champion Signatures', parallels=[P('Superfractor', 1)])
take('Ring Of Honor Signatures', parallels=[P('Foilfractor', 1)])
take('Rookie Premiere Autographs', parallels=[P('Gold Ink', 50), P('Red Ink', 5)])
take('NFL Material Autographs', parallels=RELIC_AUTO)
take('NFL Rookie Material Autographs', parallels=RELIC_AUTO)
take('NFL Material Dual Relic Autographs', parallels=RELIC_AUTO)
take('Field Fit Swatch Collection Autograph Relics', parallels=RELIC_AUTO)
take('Topps Autograph Patch Cards', parallels=PATCH_AUTO)
take('Topps Autograph Rookie Patch Cards', parallels=PATCH_AUTO)

# --- Memorabilia ---
for n in ['Real One Relics', 'Rookie Real One Relics', 'NFL Material', 'NFL Rookies Material',
          'NFL Material Dual Relics', 'Field Fit Swatch Collection',
          '1991 Topps Football Relics', '1991 Topps Football Rookie Relics']:
    take(n)

# --- Inserts ---
take('2025 All Topps Team', parallels=INSERT_PARALLELS)
take('Ring Of Honor', parallels=[P('Superfractor', 1)])
take('Topps Profiles', parallels=INSERT_PARALLELS)
take('Big Ticket Players', parallels=INSERT_PARALLELS)
take('2025 Greatest Hits', parallels=INSERT_PARALLELS)
take('Class Of ’26', parallels=INSERT_NOPINK)
take('Touchdown Machines', parallels=INSERT_NOPINK)
take('1000 Yard Club', parallels=INSERT_NOPINK)
take('4000 Yard Club', parallels=INSERT_NOPINK)
take('Wild Card Moments', parallels=INSERT_NOPINK)
take('Divisional Dominance', parallels=INSERT_NOPINK)
take('Conference Kings', parallels=INSERT_NOPINK)
take('All Hail The Champ', parallels=INSERT_NOPINK)

# 1991 base/rookie + their Chrome mirrors (same checklist, different stock).
tf = coded['1991 Topps Football']['cards']
add('1991 Topps Football', 'insert', tf, CRACKLE)
add('1991 Topps Football Chrome', 'insert',
    [{'number': c['number'].replace('91TF-', '91TC-'), 'player': c['player'], 'team': c['team']} for c in tf],
    CHROME_91, notes='Hobby/Jumbo Silver Pack Exclusive')
tr = coded['1991 Topps Rookies Football']['cards']
add('1991 Topps Rookies Football', 'insert', tr, CRACKLE)
add('1991 Topps Rookies Football Chrome', 'insert',
    [{'number': c['number'].replace('91TR-', '91TRC-'), 'player': c['player'], 'team': c['team']} for c in tr],
    CHROME_91, notes='Hobby/Jumbo Silver Pack Exclusive')

take('NFL Stars', parallels=RETAIL)
take('Pressure Cookers', parallels=RETAIL)
take('Greats Of The Game', parallels=RETAIL)
take('Big Time Players')
take('Highlight Reels')
take('Struttin’')
take('Billboard Material', parallels=[P('Foilfractor', 1)])
take('Touchdown', parallels=[P('Foilfractor', 1)])
take('All Kings', parallels=[P('Gold', 1)])
take('Fanatics Authentics Redemptions')

tfc = coded['The Flagship Collection']['cards']
add('The Flagship Collection', 'insert', tfc, notes='Super Box Exclusive')
add('The Flagship Collection Chrome', 'insert',
    [{'number': c['number'].replace('TFC-', 'TFCC-'), 'player': c['player'], 'team': c['team']} for c in tfc],
    notes='Super Box Exclusive')
take('Club Exclusive Oversized Cards')

product = {
    'id': '2026-topps-football',
    'name': '2026 Topps Football',
    'year': 2026,
    'brand': 'Topps',
    'sport': 'Football',
    'sets': sets,
}
total = sum(len(s['cards']) for s in sets)
ids = [s['id'] for s in sets]
assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
for s in sets:
    nums = [c['number'] for c in s['cards']]
    assert len(nums) == len(set(nums)), (s['name'], [n for n in nums if nums.count(n) > 1])
    assert s['totalCards'] == len(s['cards'])
json.dump(product, open('/home/user/FbAi/public/data/checklists/2026-topps-football.json', 'w', encoding='utf-8'),
          ensure_ascii=False, separators=(',', ':'))
print(f'sets={len(sets)} totalCards={total}')
for s in sets: print(f"  {s['totalCards']:>4}  {s['category']:<12} {s['name']}")
