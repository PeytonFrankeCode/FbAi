#!/usr/bin/env node
/**
 * Generate public/data/checklists/2024-topps-inception-football.json from
 * the team-by-team listings on Beckett (cross-checked against the product
 * info section). Run with `node scripts/build-2024-topps-inception-football.js`.
 *
 * Hand-curated rather than auto-parsed because Beckett's HTML mixes team
 * names with city-era prefixes and a few obvious typos ("Dallas Cowboys
 * Turner" should be "Dallas Turner"); cleaner to type the canonical version
 * once than to parse around the noise.
 */
const fs = require('fs');
const path = require('path');

const BASE_PARALLELS = [
  { name: 'Base', printRun: null },
  { name: 'Green', printRun: null },
  { name: 'Purple', printRun: '125' },
  { name: 'Magenta', printRun: '99' },
  { name: 'Red', printRun: '75' },
  { name: 'Orange', printRun: '50' },
  { name: 'Gold', printRun: '25' },
  { name: 'Blue', printRun: '10' },
  { name: 'Inception', printRun: '1' },
];

// Autographs / Memorabilia share Inception's "capped at /150" parallel ladder.
const HIT_PARALLELS = [
  { name: 'Base', printRun: null },
  { name: 'Green', printRun: '150' },
  { name: 'Purple', printRun: '125' },
  { name: 'Magenta', printRun: '99' },
  { name: 'Red', printRun: '75' },
  { name: 'Orange', printRun: '50' },
  { name: 'Gold', printRun: '25' },
  { name: 'Blue', printRun: '10' },
  { name: 'Inception', printRun: '1' },
];

const baseCards = [
  ['1',   'Hakeem Nicks',         'New York Giants'],
  ['2',   'Kurt Warner',          'Arizona Cardinals'],
  ['3',   'Michael Vick',         'Atlanta Falcons'],
  ['4',   'Lenny Moore',          'Indianapolis Colts'],
  ['5',   'Ray Lewis',            'Baltimore Ravens'],
  ['6',   'Todd Heap',            'Baltimore Ravens'],
  ['7',   'Troy Smith',           'Baltimore Ravens'],
  ['8',   'Andre Reed',           'Buffalo Bills'],
  ['9',   'Bruce Smith',          'Buffalo Bills'],
  ['10',  'Don Beebe',            'Buffalo Bills'],
  ['11',  'Doug Flutie',          'Buffalo Bills'],
  ['12',  'Eric Moulds',          'Buffalo Bills'],
  ['13',  'Jim Kelly',            'Buffalo Bills'],
  ['14',  'Muhsin Muhammad',      'Carolina Panthers'],
  ['15',  'Stephen Davis',        'Carolina Panthers'],
  ['16',  'Jim McMahon',          'Chicago Bears'],
  ['17',  'Mike Singletary',      'Chicago Bears'],
  ['18',  'Neal Anderson',        'Chicago Bears'],
  ['19',  'Willie Gault',         'Chicago Bears'],
  ['20',  'Archie Griffin',       'Cincinnati Bengals'],
  ['21',  'Boomer Esiason',       'Cincinnati Bengals'],
  ['22',  'Chad Johnson',         'Cincinnati Bengals'],
  ['23',  'Anthony Munoz',        'Cincinnati Bengals'],
  ['24',  'Josh Cribbs',          'Cleveland Browns'],
  ['25',  'Leroy Kelly',          'Cleveland Browns'],
  ['26',  'Ozzie Newsome',        'Cleveland Browns'],
  ['27',  'Calvin Hill',          'Dallas Cowboys'],
  ['28',  'Darren Woodson',       'Dallas Cowboys'],
  ['29',  'Dat Nguyen',           'Dallas Cowboys'],
  ['30',  'Drew Pearson',         'Dallas Cowboys'],
  ['31',  'Emmitt Smith',         'Dallas Cowboys'],
  ['32',  'Michael Irvin',        'Dallas Cowboys'],
  ['33',  'Roger Staubach',       'Dallas Cowboys'],
  ['34',  'Troy Aikman',          'Dallas Cowboys'],
  ['35',  'Craig Morton',         'Denver Broncos'],
  ['36',  'Ed McCaffrey',         'Denver Broncos'],
  ['37',  'Jason Elam',           'Denver Broncos'],
  ['38',  'John Elway',           'Denver Broncos'],
  ['39',  'Rod Smith',            'Denver Broncos'],
  ['40',  'Steve Atwater',        'Denver Broncos'],
  ['41',  'Terrell Davis',        'Denver Broncos'],
  ['42',  'Barry Sanders',        'Detroit Lions'],
  ['43',  'Billy Sims',           'Detroit Lions'],
  ['44',  'Chris Spielman',       'Detroit Lions'],
  ['45',  'Herman Moore',         'Detroit Lions'],
  ['46',  'Tim Tebow',            'Denver Broncos'],
  ['47',  'Antonio Freeman',      'Green Bay Packers'],
  ['48',  'Brett Favre',          'Green Bay Packers'],
  ['49',  'Dave Robinson',        'Green Bay Packers'],
  ['50',  'Don Majkowski',        'Green Bay Packers'],
  ['51',  'Dorsey Levens',        'Green Bay Packers'],
  ['52',  'Lynn Dickey',          'Green Bay Packers'],
  ['53',  'Mark Chmura',          'Green Bay Packers'],
  ['54',  'Sterling Sharpe',      'Green Bay Packers'],
  ['55',  'Dan Pastorini',        'Tennessee Titans'],
  ['56',  'Earl Campbell',        'Tennessee Titans'],
  ['57',  'Warren Moon',          'Tennessee Titans'],
  ['58',  'Arian Foster',         'Houston Texans'],
  ['59',  'J.J. Watt',            'Houston Texans'],
  ['60',  'Mario Williams',       'Houston Texans'],
  ['61',  'Dallas Clark',         'Indianapolis Colts'],
  ['62',  'Edgerrin James',       'Indianapolis Colts'],
  ['63',  'Peyton Manning',       'Indianapolis Colts'],
  ['64',  'Denard Robinson',      'Jacksonville Jaguars'],
  ['65',  'Fred Taylor',          'Jacksonville Jaguars'],
  ['66',  'Keenan McCardell',     'Jacksonville Jaguars'],
  ['67',  'Maurice Jones-Drew',   'Jacksonville Jaguars'],
  ['68',  'Christian Okoye',      'Kansas City Chiefs'],
  ['69',  'Dante Hall',           'Kansas City Chiefs'],
  ['70',  'Dwayne Bowe',          'Kansas City Chiefs'],
  ['71',  'Jamaal Charles',       'Kansas City Chiefs'],
  ['72',  'Jan Stenerud',         'Kansas City Chiefs'],
  ['73',  'Larry Johnson',        'Kansas City Chiefs'],
  ['74',  'Marcus Allen',         'Kansas City Chiefs'],
  ['75',  'Tony Richardson',      'Kansas City Chiefs'],
  ['76',  'Chris Long',           'Los Angeles Rams'],
  ['77',  'Jim Everett',          'Los Angeles Rams'],
  ['78',  'Marshall Faulk',       'Los Angeles Rams'],
  ['79',  'Nolan Cromwell',       'Los Angeles Rams'],
  ['80',  'Torry Holt',           'Los Angeles Rams'],
  ['81',  'Bob Griese',           'Miami Dolphins'],
  ['82',  'Dan Marino',           'Miami Dolphins'],
  ['83',  'Jason Taylor',         'Miami Dolphins'],
  ['84',  'Pat White',            'Miami Dolphins'],
  ['85',  'Ricky Williams',       'Miami Dolphins'],
  ['86',  'Zach Thomas',          'Miami Dolphins'],
  ['87',  'Adrian Peterson',      'Minnesota Vikings'],
  ['88',  'Chuck Foreman',        'Minnesota Vikings'],
  ['89',  'Daunte Culpepper',     'Minnesota Vikings'],
  ['90',  'John Randle',          'Minnesota Vikings'],
  ['91',  'Paul Krause',          'Minnesota Vikings'],
  ['92',  'Randall Cunningham',   'Minnesota Vikings'],
  ['93',  'Randy Moss',           'Minnesota Vikings'],
  ['94',  'Andre Tippett',        'New England Patriots'],
  ['95',  'Ben Coates',           'New England Patriots'],
  ['96',  'Danny Amendola',       'New England Patriots'],
  ['97',  'Drew Bledsoe',         'New England Patriots'],
  ['98',  'Irving Fryar',         'New England Patriots'],
  ['99',  'James White',          'New England Patriots'],
  ['100', 'Kevin Faulk',          'New England Patriots'],
  ['101', 'LeGarrette Blount',    'New England Patriots'],
  ['102', 'Mike Vrabel',          'New England Patriots'],
  ['103', 'Rob Gronkowski',       'New England Patriots'],
  ['104', 'Steve Grogan',         'New England Patriots'],
  ['105', 'Tedy Bruschi',         'New England Patriots'],
  ['106', 'Tom Brady',            'Tampa Bay Buccaneers'],
  ['107', 'Archie Manning',       'New Orleans Saints'],
  ['108', 'Dalton Hilliard',      'New Orleans Saints'],
  ['109', 'Deuce McAllister',     'New Orleans Saints'],
  ['110', 'Eli Manning',          'New York Giants'],
  ['111', 'Justin Tuck',          'New York Giants'],
  ['112', 'Lawrence Taylor',      'New York Giants'],
  ['113', 'Mario Manningham',     'New York Giants'],
  ['114', 'Phil Simms',           'New York Giants'],
  ['115', 'Rodney Hampton',       'New York Giants'],
  ['116', 'Ron Dayne',            'New York Giants'],
  ['117', 'Keyshawn Johnson',     'New York Jets'],
  ['118', 'Santana Moss',         'New York Jets'],
  ['119', 'Wayne Chrebet',        'New York Jets'],
  ['120', 'Bo Jackson',           'Las Vegas Raiders'],
  ['121', 'Fred Biletnikoff',     'Las Vegas Raiders'],
  ['122', 'Howie Long',           'Las Vegas Raiders'],
  ['123', 'Sebastian Janikowski', 'Las Vegas Raiders'],
  ['124', 'Tim Brown',            'Las Vegas Raiders'],
  ['125', 'Brian Dawkins',        'Philadelphia Eagles'],
  ['126', 'Brian Westbrook',      'Philadelphia Eagles'],
  ['127', 'Donovan McNabb',       'Philadelphia Eagles'],
  ['128', 'Keith Byars',          'Philadelphia Eagles'],
  ['129', 'Barry Foster',         'Pittsburgh Steelers'],
  ['130', 'Charlie Batch',        'Pittsburgh Steelers'],
  ['131', 'Donnie Shell',         'Pittsburgh Steelers'],
  ['132', 'Hines Ward',           'Pittsburgh Steelers'],
  ['133', 'Jack Lambert',         'Pittsburgh Steelers'],
  ['134', 'James Harrison',       'Pittsburgh Steelers'],
  ['135', 'Jerome Bettis',        'Pittsburgh Steelers'],
  ['136', 'Joey Porter',          'Pittsburgh Steelers'],
  ['137', 'Terry Bradshaw',       'Pittsburgh Steelers'],
  ['138', 'Antonio Gates',        'Los Angeles Chargers'],
  ['139', 'Dan Fouts',            'Los Angeles Chargers'],
  ['140', 'Frank Gore',           'San Francisco 49ers'],
  ['141', 'Jeff Garcia',          'San Francisco 49ers'],
  ['142', 'Jerry Rice',           'San Francisco 49ers'],
  ['143', 'Joe Montana',          'San Francisco 49ers'],
  ['144', 'Steve Young',          'San Francisco 49ers'],
  ['145', 'Shaun Alexander',      'Seattle Seahawks'],
  ['146', 'Doug Williams',        'Tampa Bay Buccaneers'],
  ['147', 'Chris Johnson',        'Tennessee Titans'],
  ['148', 'Delanie Walker',       'Tennessee Titans'],
  ['149', 'Eddie George',         'Tennessee Titans'],
  ['150', 'Jevon Kearse',         'Tennessee Titans'],
  // Rookies 151-200
  ['151', 'Cooper DeJean',        'Philadelphia Eagles'],
  ['152', 'Nate Wiggins',         'Baltimore Ravens'],
  ['153', 'Chop Robinson',        'Miami Dolphins'],
  ['154', 'Quinyon Mitchell',     'Philadelphia Eagles'],
  ['155', 'Dallas Turner',        'Minnesota Vikings'],
  ['156', 'Laiatu Latu',          'Indianapolis Colts'],
  ['157', 'Caleb Williams',       'Chicago Bears'],
  ['158', 'Drake Maye',           'New England Patriots'],
  ['159', 'Jayden Daniels',       'Washington Commanders'],
  ['160', 'Terrion Arnold',       'Detroit Lions'],
  ['161', 'Bo Nix',               'Denver Broncos'],
  ['162', 'Michael Pratt',        'Tampa Bay Buccaneers'],
  ['163', 'Spencer Rattler',      'New Orleans Saints'],
  ['164', "Jer'Zhan Newton",      'Washington Commanders'],
  ['165', "T'Vondre Sweat",       'Tennessee Titans'],
  ['166', 'Brock Bowers',         'Las Vegas Raiders'],
  ['167', "Ja'Tavion Sanders",    'Carolina Panthers'],
  ['168', 'Cade Stover',          'Houston Texans'],
  ['169', 'Marvin Harrison Jr.',  'Arizona Cardinals'],
  ['170', 'Malik Nabers',         'New York Giants'],
  ['171', 'Keon Coleman',         'Buffalo Bills'],
  ['172', 'Xavier Worthy',        'Kansas City Chiefs'],
  ['173', 'Luke McCaffrey',       'Washington Commanders'],
  ['174', 'Adonai Mitchell',      'Indianapolis Colts'],
  ['175', 'Xavier Legette',       'Carolina Panthers'],
  ['176', 'Ladd McConkey',        'Los Angeles Chargers'],
  ['177', 'Johnny Wilson',        'Philadelphia Eagles'],
  ['178', 'Troy Franklin',        'Denver Broncos'],
  ['179', 'Malachi Corley',       'New York Jets'],
  ['180', 'Jacob Cowing',         'San Francisco 49ers'],
  ['181', 'Jermaine Burton',      'Cincinnati Bengals'],
  ['182', 'Edgerrin Cooper',      'Green Bay Packers'],
  ['183', 'Jalen McMillan',       'Tampa Bay Buccaneers'],
  ['184', 'Roman Wilson',         'Pittsburgh Steelers'],
  ['185', "Ja'Lynn Polk",         'New England Patriots'],
  ['186', 'Jonathon Brooks',      'Carolina Panthers'],
  ['187', 'Trey Benson',          'Arizona Cardinals'],
  ['188', 'Audric Estimé',        'Denver Broncos'],
  ['189', 'Blake Corum',          'Los Angeles Rams'],
  ['190', 'Bucky Irving',         'Tampa Bay Buccaneers'],
  ['191', 'Tyler Nubin',          'New York Giants'],
  ['192', 'Maason Smith',         'Jacksonville Jaguars'],
  ['193', 'Michael Hall Jr.',     'Cleveland Browns'],
  ['194', 'MarShawn Lloyd',       'Green Bay Packers'],
  ['195', 'Will Shipley',         'Philadelphia Eagles'],
  ['196', 'Chris Braswell',       'Tampa Bay Buccaneers'],
  ['197', 'Javon Bullard',        'Green Bay Packers'],
  ['198', 'Ainias Smith',         'Philadelphia Eagles'],
  ['199', 'Kris Jenkins Jr.',     'Cincinnati Bengals'],
  ['200', 'Kamren Kinchens',      'Los Angeles Rams'],
];

// Cards that appear only in autograph / relic / insert sets, keyed by suffix
// for easy lookup. Single-pass team/player canonicalisation.
const meta = {};
function m(key, player, team) { meta[key] = { player, team }; }

// Veteran/legend players who only appear in relics & dawn-of-greatness
m('AP', 'Adrian Peterson',     'Minnesota Vikings');
m('AF', 'Antonio Freeman',     'Green Bay Packers');
m('AG', 'Archie Griffin',      'Cincinnati Bengals');
m('BSA','Barry Sanders',       'Detroit Lions');
m('BS', 'Billy Sims',          'Detroit Lions');
m('BY', 'Bryce Young',         'Carolina Panthers');
m('CS', 'C.J. Stroud',         'Houston Texans');
m('DM_RC','Dan Marino',        'Miami Dolphins');
m('DH', 'Dante Hall',          'Kansas City Chiefs');
m('DSP','Darren Sproles',      'Los Angeles Chargers');
m('DS', 'Donnie Shell',        'Pittsburgh Steelers');
m('DF_RC','Doug Flutie',       'Buffalo Bills');
m('DP', 'Drew Pearson',        'Dallas Cowboys');
m('EJ', 'Edgerrin James',      'Indianapolis Colts');
m('EM', 'Eli Manning',         'New York Giants');
m('JC', 'Jamaal Charles',      'Kansas City Chiefs');
m('JWatt','J.J. Watt',         'Houston Texans');
m('JW_RC','James White',       'New England Patriots');
m('KJ', 'Keyshawn Johnson',    'New York Jets');
m('KW', 'Kurt Warner',         'Arizona Cardinals');
m('MS', 'Mike Singletary',     'Chicago Bears');
m('PM', 'Peyton Manning',      'Indianapolis Colts');
m('PW_RC','Patrick Willis',    'San Francisco 49ers');
m('RM', 'Randy Moss',          'Minnesota Vikings');
m('RG', 'Rob Gronkowski',      'New England Patriots');
m('SA', 'Steve Atwater',       'Denver Broncos');
m('TA_RC','Troy Aikman',       'Dallas Cowboys');
m('TB_BRADY','Tom Brady',      'Tampa Bay Buccaneers');
m('TT', 'Thurman Thomas',      'Buffalo Bills');
m('WL', 'Will Levis',          'Tennessee Titans');

// Rookies & first-year players (key = card-code suffix)
m('AE', 'Audric Estimé',       'Denver Broncos');
m('AM', 'Adonai Mitchell',     'Indianapolis Colts');
m('AS', 'Ainias Smith',        'Philadelphia Eagles');
m('BB', 'Brock Bowers',        'Las Vegas Raiders');
m('BC', 'Blake Corum',         'Los Angeles Rams');
m('BI', 'Bucky Irving',        'Tampa Bay Buccaneers');
m('BN', 'Bo Nix',              'Denver Broncos');
m('BRI','Brenden Rice',        'Los Angeles Chargers');
m('BRT','Bralen Trice',        'Atlanta Falcons');
m('CB', 'Cole Bishop',         'Buffalo Bills');
m('CD', 'Cooper DeJean',       'Philadelphia Eagles');
m('CR', 'Chop Robinson',       'Miami Dolphins');
m('CS_RK','Cade Stover',       'Houston Texans');
m('CW', 'Caleb Williams',      'Chicago Bears');
m('DM', 'Drake Maye',          'New England Patriots');
m('DT', 'Dallas Turner',       'Minnesota Vikings');
m('DTU','Dallas Turner',       'Minnesota Vikings');
m('DW', 'Devontez Walker',     'Baltimore Ravens');
m('ERJ','Ennis Rakestraw Jr.', 'Detroit Lions'),
m('JA', 'Joe Alt',             'Los Angeles Chargers');
m('JAB','Javon Bullard',       'Green Bay Packers');
m('JB', 'Jonathon Brooks',     'Carolina Panthers');
m('JBR','Jonathon Brooks',     'Carolina Panthers');
m('JB_BURT','Jermaine Burton', 'Cincinnati Bengals');
m('JBU','Jermaine Burton',     'Cincinnati Bengals');
m('JC_COWING','Jacob Cowing',  'San Francisco 49ers');
m('JCO','Junior Colson',       'Los Angeles Chargers');
m('JD', 'Jayden Daniels',      'Washington Commanders');
m('JE', 'Jonah Elliss',        'Denver Broncos');
m('JLP','Ja’Lynn Polk',   'New England Patriots');
m('JM', 'Jalen McMillan',      'Tampa Bay Buccaneers');
m('JP', 'Ja’Lynn Polk',   'New England Patriots');
m('JS', 'Ja’Tavion Sanders','Carolina Panthers');
m('JSA','Ja’Tavion Sanders','Carolina Panthers');
m('JTS','Ja’Tavion Sanders','Carolina Panthers');
m('JW', 'Johnny Wilson',       'Philadelphia Eagles');
m('JWR','Jaylen Wright',       'Miami Dolphins');
m('KC', 'Keon Coleman',        'Buffalo Bills');
m('LAM','Ladd McConkey',       'Los Angeles Chargers');
m('LL', 'Laiatu Latu',         'Indianapolis Colts');
m('LM', 'Ladd McConkey',       'Los Angeles Chargers');
m('LMC','Luke McCaffrey',      'Washington Commanders');
m('MC', 'Malachi Corley',      'New York Jets');
m('ML', 'MarShawn Lloyd',      'Green Bay Packers');
m('MN', 'Malik Nabers',        'New York Giants');
m('MP', 'Michael Pratt',       'Tampa Bay Buccaneers');
m('MWA','Malik Washington',    'Miami Dolphins');
m('NW', 'Nate Wiggins',        'Baltimore Ravens');
m('PW_WIL','Payton Wilson',    'Pittsburgh Steelers');
m('RD', 'Ray Davis',           'Buffalo Bills');
m('RP', 'Ricky Pearsall',      'San Francisco 49ers');
m('RW', 'Roman Wilson',        'Pittsburgh Steelers');
m('SR', 'Spencer Rattler',     'New Orleans Saints');
m('TB', 'Trey Benson',         'Arizona Cardinals');
m('TBE','Trey Benson',         'Arizona Cardinals');
m('TF', 'Troy Franklin',       'Denver Broncos');
m('WS', 'Will Shipley',        'Philadelphia Eagles');
m('XL', 'Xavier Legette',      'Carolina Panthers');
m('XW', 'Xavier Worthy',       'Kansas City Chiefs');

function single(prefix, suffix, key) {
  const info = meta[key || suffix];
  if (!info) throw new Error(`No meta for ${prefix}-${suffix} / lookup ${key || suffix}`);
  return { number: `${prefix}-${suffix}`, player: info.player, team: info.team };
}

function dual(prefix, suffix, player1Key, player2Key) {
  const a = meta[player1Key];
  const b = meta[player2Key];
  if (!a || !b) throw new Error(`Missing meta for dual ${prefix}-${suffix}`);
  // Use the first listed player's team since these book/dual cards span teams.
  return {
    number: `${prefix}-${suffix}`,
    player: `${a.player} / ${b.player}`,
    team: a.team,
  };
}

const sets = [
  {
    id: 'base-set',
    name: 'Base Set',
    category: 'base',
    totalCards: baseCards.length,
    parallels: BASE_PARALLELS,
    cards: baseCards.map(([number, player, team]) => ({ number, player, team })),
  },

  // ---- Autographs ----
  {
    id: 'dawn-of-greatness-autographs',
    name: 'Dawn of Greatness Autographs',
    category: 'autograph',
    totalCards: 19,
    parallels: [
      { name: 'Base', printRun: '20' },
      { name: 'Orange', printRun: '10' },
      { name: 'Blue', printRun: '5' },
      { name: 'Inception', printRun: '1' },
    ],
    cards: [
      single('DGA', 'KC'),
      single('DGA', 'BY'),
      single('DGA', 'CW'),
      single('DGA', 'AP'),
      single('DGA', 'RM'),
      single('DGA', 'CS'),
      single('DGA', 'JW',  'JWatt'),
      single('DGA', 'PM'),
      single('DGA', 'EJ'),
      single('DGA', 'EM'),
      single('DGA', 'MN'),
      single('DGA', 'BN'),
      single('DGA', 'BB'),
      single('DGA', 'KW'),
      single('DGA', 'DM'),
      single('DGA', 'RG'),
      single('DGA', 'TB',  'TB_BRADY'),
      single('DGA', 'JD'),
      single('DGA', 'WL'),
    ],
  },
  {
    id: 'dual-rookie-relic-autographs',
    name: 'Dual Rookie Relic Autographs',
    category: 'autograph',
    totalCards: 5,
    parallels: HIT_PARALLELS,
    cards: [
      dual('DRRA', 'WD', 'CW', 'JD'),
      dual('DRRA', 'WR', 'SR', 'CW'),
      dual('DRRA', 'MR', 'BRI', 'LM'),
      dual('DRRA', 'DM', 'DM', 'JD'),
      dual('DRRA', 'DN', 'JD', 'MN'),
    ],
  },
  {
    id: 'dual-rookie-relic-autographed-book',
    name: 'Dual Rookie Relic Autographed Book',
    category: 'autograph',
    totalCards: 6,
    parallels: [{ name: 'Base', printRun: '99' }],
    cards: [
      dual('DRRBC', 'CW', 'CW', 'DM'),
      dual('DRRBC', 'LR', 'SR', 'XL'),
      dual('DRRBC', 'NP', 'BN', 'MP'),
      dual('DRRBC', 'DW', 'JD', 'XW'),
      dual('DRRBC', 'IM', 'BI', 'JM'),
      { number: 'DRRBC-HJN', player: 'Malik Nabers', team: 'New York Giants' },
    ],
  },
  {
    id: 'franchise-foundation-relic-autographs',
    name: 'Franchise Foundation Relic Autographs',
    category: 'autograph',
    totalCards: 14,
    parallels: HIT_PARALLELS,
    cards: [
      single('FFRA', 'TB'),
      single('FFRA', 'CW'),
      single('FFRA', 'BN'),
      single('FFRA', 'MP'),
      single('FFRA', 'BB'),
      single('FFRA', 'BC'),
      single('FFRA', 'CR'),
      single('FFRA', 'DT'),
      single('FFRA', 'DM'),
      single('FFRA', 'JLP'),
      single('FFRA', 'SR'),
      single('FFRA', 'MN'),
      single('FFRA', 'CD'),
      single('FFRA', 'JD'),
    ],
  },
  {
    id: 'genesis-book-autographs',
    name: 'Genesis Book Autographs',
    category: 'autograph',
    totalCards: 24,
    parallels: [{ name: 'Base', printRun: '99' }],
    cards: [
      single('ARBC', 'TBE'),
      single('ARBC', 'KC'),
      single('ARBC', 'JB'),
      single('ARBC', 'JS'),
      single('ARBC', 'XL'),
      single('ARBC', 'CW'),
      single('ARBC', 'BN'),
      single('ARBC', 'ML'),
      single('ARBC', 'MP'),
      single('ARBC', 'AM'),
      single('ARBC', 'XW'),
      single('ARBC', 'BRI'),
      single('ARBC', 'LM'),
      single('ARBC', 'BC'),
      single('ARBC', 'CR'),
      single('ARBC', 'DTU'),
      single('ARBC', 'BB'),
      single('ARBC', 'DM'),
      single('ARBC', 'JP'),
      single('ARBC', 'SR'),
      single('ARBC', 'MN'),
      single('ARBC', 'RW'),
      single('ARBC', 'CD'),
      single('ARBC', 'JD'),
    ],
  },
  {
    id: 'inception-silver-signings',
    name: 'Inception Silver Signings',
    category: 'autograph',
    totalCards: 9,
    parallels: [
      { name: 'Base', printRun: '100' },
      { name: 'Gold Ink', printRun: '25' },
      { name: 'Gold Ink Inscription', printRun: '1' },
    ],
    cards: [
      single('ISS', 'KC'),
      single('ISS', 'CW'),
      single('ISS', 'BN'),
      single('ISS', 'XW'),
      single('ISS', 'BB'),
      single('ISS', 'DM'),
      single('ISS', 'MN'),
      single('ISS', 'JD'),
      single('ISS', 'RP'),
    ],
  },
  {
    id: 'provenance-patch-autographs',
    name: 'Provenance Patch Autographs',
    category: 'autograph',
    totalCards: 36,
    parallels: HIT_PARALLELS,
    cards: [
      single('PPA', 'TB'),
      single('PPA', 'KC'),
      single('PPA', 'JBR'),
      single('PPA', 'JSA'),
      single('PPA', 'XL'),
      single('PPA', 'CW'),
      single('PPA', 'JB',  'JB_BURT'),
      single('PPA', 'AE'),
      single('PPA', 'BN'),
      single('PPA', 'TF'),
      single('PPA', 'ML'),
      single('PPA', 'MP'),
      single('PPA', 'AM'),
      single('PPA', 'XW'),
      single('PPA', 'BRI'),
      single('PPA', 'JCO'),
      single('PPA', 'LM'),
      single('PPA', 'BC'),
      single('PPA', 'JWR'),
      single('PPA', 'DT'),
      single('PPA', 'BB'),
      single('PPA', 'DM'),
      single('PPA', 'JP'),
      single('PPA', 'MC'),
      single('PPA', 'MN'),
      single('PPA', 'CD'),
      single('PPA', 'JW'),
      single('PPA', 'WS'),
      single('PPA', 'PW',  'PW_WIL'),
      single('PPA', 'RW'),
      single('PPA', 'JC',  'JC_COWING'),
      single('PPA', 'BI'),
      single('PPA', 'JM'),
      single('PPA', 'SR'),
      single('PPA', 'JD'),
      single('PPA', 'LMC'),
    ],
  },
  {
    id: 'rookie-autographs',
    name: 'Rookie Autographs',
    category: 'autograph',
    totalCards: 35,
    parallels: [
      { name: 'Base', printRun: null },
      { name: 'Green', printRun: '150' },
      { name: 'Purple', printRun: '125' },
      { name: 'Magenta', printRun: '99' },
      { name: 'Red', printRun: '75' },
      { name: 'Orange', printRun: '50' },
      { name: 'Gold', printRun: '25' },
      { name: 'Blue', printRun: '10' },
      { name: 'Inception', printRun: '1' },
    ],
    cards: [
      single('RA', 'TB'),
      single('RA', 'BRT'),
      single('RA', 'DW'),
      single('RA', 'NW'),
      single('RA', 'CB'),
      single('RA', 'KC'),
      single('RA', 'RD'),
      single('RA', 'JB',  'JB'),
      single('RA', 'JSA'),
      single('RA', 'XL'),
      single('RA', 'CW'),
      single('RA', 'AE'),
      single('RA', 'BN'),
      single('RA', 'JE'),
      single('RA', 'TF'),
      single('RA', 'ERJ'),
      single('RA', 'TA',  'JTS'),     // duplicate-suffix guard
      single('RA', 'JBU'),
      single('RA', 'JAB'),
      single('RA', 'ML'),
      single('RA', 'MP'),
      single('RA', 'AM'),
      single('RA', 'LL'),
      single('RA', 'XW'),
      single('RA', 'JA'),
      single('RA', 'JUC', 'JCO'),
      single('RA', 'LM'),
      single('RA', 'CR'),
      single('RA', 'JWR'),
      single('RA', 'MWA'),
      single('RA', 'DT'),
      single('RA', 'DM'),
      single('RA', 'JP'),
      single('RA', 'SR'),
      single('RA', 'MN'),
      single('RA', 'MC'),
      single('RA', 'AS'),
      single('RA', 'JW'),
      single('RA', 'WS'),
      single('RA', 'RW'),
      single('RA', 'RP'),
      single('RA', 'CS',  'CS_RK'),
      single('RA', 'BB'),
      single('RA', 'BC'),
      single('RA', 'JD'),
      single('RA', 'LMC'),
    ],
  },
  {
    id: 'rookie-autographs-variations',
    name: 'Rookie Autographs Variations',
    category: 'autograph',
    totalCards: 16,
    parallels: [
      { name: 'Base', printRun: null },
      { name: 'Green', printRun: '150' },
      { name: 'Purple', printRun: '125' },
      { name: 'Magenta', printRun: '99' },
      { name: 'Red', printRun: '75' },
      { name: 'Orange', printRun: '50' },
      { name: 'Gold', printRun: '25' },
      { name: 'Blue', printRun: '10' },
      { name: 'Inception', printRun: '1' },
    ],
    cards: [
      single('RAV', 'TB'),
      single('RAV', 'KC'),
      single('RAV', 'JB',  'JB'),
      single('RAV', 'XL'),
      single('RAV', 'CW'),
      single('RAV', 'BN'),
      single('RAV', 'ML'),
      single('RAV', 'MP'),
      single('RAV', 'AM'),
      single('RAV', 'XW'),
      single('RAV', 'LAM'),
      single('RAV', 'DM'),
      single('RAV', 'SR'),
      single('RAV', 'MN'),
      single('RAV', 'RP'),
      single('RAV', 'BB'),
      single('RAV', 'BC'),
      single('RAV', 'JD'),
      single('RAV', 'LMC'),
    ],
  },
  {
    id: 'rookie-jumbo-relic-autographs',
    name: 'Rookie Jumbo Relic Autographs',
    category: 'autograph',
    totalCards: 13,
    parallels: HIT_PARALLELS,
    cards: [
      single('RJRA', 'TB'),
      single('RJRA', 'JTS'),
      single('RJRA', 'CW'),
      single('RJRA', 'BN'),
      single('RJRA', 'MP'),
      single('RJRA', 'AM'),
      single('RJRA', 'XW'),
      single('RJRA', 'BB'),
      single('RJRA', 'CR'),
      single('RJRA', 'DT'),
      single('RJRA', 'DM'),
      single('RJRA', 'SR'),
      single('RJRA', 'MN'),
      single('RJRA', 'CD'),
      single('RJRA', 'BC'),
      single('RJRA', 'JD'),
      single('RJRA', 'LMC'),
    ],
  },

  // ---- Memorabilia ----
  {
    id: 'freshman-initiation',
    name: 'Freshman Initiation',
    category: 'memorabilia',
    totalCards: 25,
    parallels: [
      { name: 'Base', printRun: '150' },
      { name: 'Purple', printRun: '125' },
      { name: 'Magenta', printRun: '99' },
      { name: 'Red', printRun: '75' },
      { name: 'Orange', printRun: '50' },
      { name: 'Gold', printRun: '25' },
      { name: 'Blue', printRun: '10' },
      { name: 'Inception', printRun: '1' },
    ],
    cards: [
      { number: 'FI-1',  player: 'Bucky Irving',         team: 'Tampa Bay Buccaneers' },
      { number: 'FI-2',  player: 'Trey Benson',          team: 'Arizona Cardinals' },
      { number: 'FI-3',  player: 'Brock Bowers',         team: 'Las Vegas Raiders' },
      { number: 'FI-4',  player: 'Jonathon Brooks',      team: 'Carolina Panthers' },
      { number: 'FI-5',  player: 'Keon Coleman',         team: 'Buffalo Bills' },
      { number: 'FI-6',  player: 'Blake Corum',          team: 'Los Angeles Rams' },
      { number: 'FI-7',  player: 'Jayden Daniels',       team: 'Washington Commanders' },
      { number: 'FI-8',  player: 'Troy Franklin',        team: 'Denver Broncos' },
      { number: 'FI-9',  player: 'Marvin Harrison Jr.',  team: 'Arizona Cardinals' },
      { number: 'FI-10', player: 'Xavier Legette',       team: 'Carolina Panthers' },
      { number: 'FI-11', player: 'Drake Maye',           team: 'New England Patriots' },
      { number: 'FI-12', player: 'Ladd McConkey',        team: 'Los Angeles Chargers' },
      { number: 'FI-13', player: 'Adonai Mitchell',      team: 'Indianapolis Colts' },
      { number: 'FI-14', player: 'Malik Nabers',         team: 'New York Giants' },
      { number: 'FI-15', player: 'Bo Nix',               team: 'Denver Broncos' },
      { number: 'FI-16', player: 'Ja’Lynn Polk',    team: 'New England Patriots' },
      { number: 'FI-17', player: 'Michael Pratt',        team: 'Tampa Bay Buccaneers' },
      { number: 'FI-18', player: 'Spencer Rattler',      team: 'New Orleans Saints' },
      { number: 'FI-19', player: 'Ja’Tavion Sanders', team: 'Carolina Panthers' },
      { number: 'FI-20', player: 'Will Shipley',         team: 'Philadelphia Eagles' },
      { number: 'FI-21', player: 'Dallas Turner',        team: 'Minnesota Vikings' },
      { number: 'FI-22', player: 'Caleb Williams',       team: 'Chicago Bears' },
      { number: 'FI-23', player: 'Roman Wilson',         team: 'Pittsburgh Steelers' },
      { number: 'FI-24', player: 'Xavier Worthy',        team: 'Kansas City Chiefs' },
      { number: 'FI-25', player: 'Jaylen Wright',        team: 'Miami Dolphins' },
    ],
  },
  {
    id: 'relics',
    name: 'Relics',
    category: 'memorabilia',
    totalCards: 22,
    parallels: HIT_PARALLELS,
    cards: [
      single('RC', 'KW'),
      single('RC', 'AG'),
      single('RC', 'DF',  'DF_RC'),
      single('RC', 'TT'),
      single('RC', 'MS'),
      single('RC', 'DP'),
      single('RC', 'TA',  'TA_RC'),
      single('RC', 'SA'),
      single('RC', 'BS'),
      single('RC', 'BSA'),
      single('RC', 'AF'),
      single('RC', 'PM'),
      single('RC', 'DH'),
      single('RC', 'JC'),
      single('RC', 'DSP'),
      single('RC', 'RM'),
      single('RC', 'DM',  'DM_RC'),
      single('RC', 'JW',  'JW_RC'),
      single('RC', 'KJ'),
      single('RC', 'DS'),
      single('RC', 'PW',  'PW_RC'),
    ],
  },
  {
    id: 'rookie-jumbo-relics',
    name: 'Rookie Jumbo Relics',
    category: 'memorabilia',
    totalCards: 19,
    parallels: HIT_PARALLELS,
    cards: [
      single('RJR', 'TB'),
      single('RJR', 'KC'),
      single('RJR', 'JB',  'JB'),
      single('RJR', 'JS'),
      single('RJR', 'XL'),
      single('RJR', 'CW'),
      single('RJR', 'BN'),
      single('RJR', 'AM'),
      single('RJR', 'XW'),
      single('RJR', 'BB'),
      single('RJR', 'LM'),
      single('RJR', 'JW',  'JWR'),
      single('RJR', 'DT'),
      single('RJR', 'DM'),
      single('RJR', 'JP'),
      single('RJR', 'SR'),
      single('RJR', 'MN'),
      single('RJR', 'WS'),
      single('RJR', 'RW'),
      single('RJR', 'BI'),
      single('RJR', 'MP'),
      single('RJR', 'BC'),
      single('RJR', 'JD'),
    ],
  },
  {
    id: 'source-materials',
    name: 'Source Materials',
    category: 'memorabilia',
    totalCards: 14,
    parallels: HIT_PARALLELS,
    cards: [
      single('SM', 'DW'),
      single('SM', 'KC'),
      single('SM', 'XL'),
      single('SM', 'CW'),
      single('SM', 'JB',  'JB_BURT'),
      single('SM', 'BN'),
      single('SM', 'AM'),
      single('SM', 'XW'),
      single('SM', 'LM'),
      single('SM', 'ML'),
      single('SM', 'DM'),
      single('SM', 'JP'),
      single('SM', 'DT'),
      single('SM', 'MN'),
      single('SM', 'MC'),
      single('SM', 'RP'),
      single('SM', 'JM'),
      single('SM', 'RW'),
      single('SM', 'JD'),
    ],
  },
];

const product = {
  id: '2024-topps-inception-football',
  name: '2024 Topps Inception Football',
  year: 2024,
  brand: 'Topps Inception',
  sport: 'Football',
  sets,
};

// Total cards across every set, like the index expects.
const totalCards = sets.reduce((s, x) => s + x.cards.length, 0);

const outPath = path.join(__dirname, '..', 'public', 'data', 'checklists', '2024-topps-inception-football.json');
fs.writeFileSync(outPath, JSON.stringify(product));
console.log(`Wrote ${outPath}`);
console.log(`  ${sets.length} sets, ${totalCards} cards`);

// Update index.json — replace existing entry if present, else append.
const indexPath = path.join(__dirname, '..', 'public', 'data', 'checklists', 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
const entry = {
  id: product.id,
  name: product.name,
  year: product.year,
  brand: product.brand,
  sport: product.sport,
  setCount: sets.length,
  totalCards,
};
const idx = index.products.findIndex(p => p.id === entry.id);
if (idx >= 0) index.products[idx] = entry;
else index.products.push(entry);
fs.writeFileSync(indexPath, JSON.stringify(index));
console.log(`Updated ${indexPath}: ${idx >= 0 ? 'replaced' : 'added'} ${entry.id}`);
