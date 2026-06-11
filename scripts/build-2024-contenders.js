#!/usr/bin/env node
/**
 * Build a clean 2024 Panini Contenders Football checklist JSON from the
 * published Beckett master card list. The previously generated file lost all
 * parallel print runs (everything collapsed to "Base"), dropped the card
 * lists for nine sets, mis-parsed parallel lines into their own bogus sets,
 * and was missing the 245-card numbered Ticket Stub list. This rebuilds the
 * product from source so the schema matches the other checklist files:
 *   set = { id, name, category, totalCards, parallels:[{name,printRun}], cards:[{number,player,team,printRun?,note?}] }
 *
 * Run: node scripts/build-2024-contenders.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'data', 'checklists', '2024-panini-contenders-football.json');
const INDEX = path.join(__dirname, '..', 'public', 'data', 'checklists', 'index.json');

const P = (name, printRun = null) => ({ name, printRun });

// Parse a verbatim card block. Each non-empty line looks like:
//   "<num> <Player>, <Team> [/<printRun>] [(note)]"
// Dual-player insert lines keep slashes inside player/team ("A/B, Team1/Team2").
function cards(block) {
  return block.trim().split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    let note = null, printRun = null;
    line = line.replace(/\s*\(([^)]*)\)\s*$/, (_, n) => { note = n.trim(); return ''; });
    line = line.replace(/\s*\/(\d+)\s*$/, (_, pr) => { printRun = parseInt(pr, 10); return ''; });
    const m = line.match(/^(\d+)\s+(.+?),\s*(.+)$/);
    if (!m) throw new Error('Unparseable card line: ' + JSON.stringify(line));
    const c = { number: m[1], player: m[2].trim(), team: m[3].trim() };
    if (printRun != null) c.printRun = printRun;
    if (note) c.note = note;
    return c;
  });
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

function set(name, category, parallels, block, totalOverride) {
  const cardList = block ? cards(block) : [];
  return {
    id: slug(name),
    name,
    category,
    totalCards: totalOverride != null ? totalOverride : cardList.length,
    parallels: parallels && parallels.length ? parallels : [P('Base')],
    cards: cardList,
  };
}

// ---- Season Ticket (Base #1-100) ----
const SEASON_TICKET_PARALLELS = [
  P('Base'), P('Retail'), P('Game Ticket Bronze'), P('Game Ticket Orange'), P('Game Ticket Red'),
  P('Opening Kickoff Ticket'), P('Game Ticket Blue', 499), P('Playoff Ticket', 199), P('Game Ticket Green', 175),
  P('Divisional Ticket', 149), P('Conference Ticket', 99), P('Ticket Stub (/99 or less)'), P('Game Ticket Teal', 75),
  P('Midfield Ticket', 50), P('Red Zone Ticket FOTL', 49), P('Cracked Ice Ticket', 25), P('Week 18 Ticket', 18),
  P('Game Ticket Gold', 10), P('Goal Line Ticket FOTL', 5), P('Super Bowl Ticket', 1), P('Printing Plates', 1),
];

const seasonTicket = `
1 Trey McBride, Arizona Cardinals
2 James Conner, Arizona Cardinals
3 Kyler Murray, Arizona Cardinals
4 Kirk Cousins, Atlanta Falcons
5 Drake London, Atlanta Falcons
6 Bijan Robinson, Atlanta Falcons
7 Lamar Jackson, Baltimore Ravens
8 Zay Flowers, Baltimore Ravens
9 Derrick Henry, Baltimore Ravens
10 James Cook, Buffalo Bills
11 Josh Allen, Buffalo Bills
12 Dalton Kincaid, Buffalo Bills
13 Josey Jewell, Carolina Panthers
14 Bryce Young, Carolina Panthers
15 Adam Thielen, Carolina Panthers
16 D’Andre Swift, Chicago Bears
17 Keenan Allen, Chicago Bears
18 DJ Moore, Chicago Bears
19 Trey Hendrickson, Cincinnati Bengals
20 Joe Burrow, Cincinnati Bengals
21 Ja’Marr Chase, Cincinnati Bengals
22 Amari Cooper, Buffalo Bills
23 Nick Chubb, Cleveland Browns
24 Myles Garrett, Cleveland Browns
25 Dak Prescott, Dallas Cowboys
26 CeeDee Lamb, Dallas Cowboys
27 Micah Parsons, Dallas Cowboys
28 Courtland Sutton, Denver Broncos
29 Javonte Williams, Denver Broncos
30 Patrick Surtain II, Denver Broncos
31 Jared Goff, Detroit Lions
32 Jahmyr Gibbs, Detroit Lions
33 Amon-Ra St. Brown, Detroit Lions
34 Aidan Hutchinson, Detroit Lions
35 Josh Jacobs, Green Bay Packers
36 Christian Watson, Green Bay Packers
37 Jordan Love, Green Bay Packers
38 Jaire Alexander, Green Bay Packers
39 C.J. Stroud, Houston Texans
40 Stefon Diggs, Houston Texans
41 Nico Collins, Houston Texans
42 Anthony Richardson, Indianapolis Colts
43 Jonathan Taylor, Indianapolis Colts
44 Zaire Franklin, Indianapolis Colts
45 Evan Engram, Jacksonville Jaguars
46 Trevor Lawrence, Jacksonville Jaguars
47 Travis Etienne Jr., Jacksonville Jaguars
48 Travis Kelce, Kansas City Chiefs
49 Harrison Butker, Kansas City Chiefs
50 Patrick Mahomes II, Kansas City Chiefs
51 George Karlaftis, Kansas City Chiefs
52 Maxx Crosby, Las Vegas Raiders
53 Gardner Minshew II, Las Vegas Raiders
54 Davante Adams, New York Jets
55 Justin Herbert, Los Angeles Chargers
56 Josh Palmer, Los Angeles Chargers
57 Khalil Mack, Los Angeles Chargers
58 Cooper Kupp, Los Angeles Rams
59 Puka Nacua, Los Angeles Rams
60 Kyren Williams, Los Angeles Rams
61 Tua Tagovailoa, Miami Dolphins
62 Tyreek Hill, Miami Dolphins
63 Jaylen Waddle, Miami Dolphins
64 Aaron Jones, Minnesota Vikings
65 Justin Jefferson, Minnesota Vikings
66 Harrison Smith, Minnesota Vikings
67 Jacoby Brissett, New England Patriots
68 Rhamondre Stevenson, New England Patriots
69 Kendrick Bourne, New England Patriots
70 Chris Olave, New Orleans Saints
71 Alvin Kamara, New Orleans Saints
72 Derek Carr, New Orleans Saints
73 Daniel Jones, New York Giants
74 Brian Burns, New York Giants
75 Darius Slayton, New York Giants
76 Breece Hall, New York Jets
77 Garrett Wilson, New York Jets
78 Aaron Rodgers, New York Jets
79 Jalen Hurts, Philadelphia Eagles
80 Saquon Barkley, Philadelphia Eagles
81 A.J. Brown, Philadelphia Eagles
82 Russell Wilson, Pittsburgh Steelers
83 T.J. Watt, Pittsburgh Steelers
84 Pat Freiermuth, Pittsburgh Steelers
85 George Kittle, San Francisco 49ers
86 Christian McCaffrey, San Francisco 49ers
87 Deebo Samuel, San Francisco 49ers
88 Brock Purdy, San Francisco 49ers
89 Kenneth Walker III, Seattle Seahawks
90 Tyler Lockett, Seattle Seahawks
91 DK Metcalf, Seattle Seahawks
92 Baker Mayfield, Tampa Bay Buccaneers
93 Mike Evans, Tampa Bay Buccaneers
94 Rachaad White, Tampa Bay Buccaneers
95 Will Levis, Tennessee Titans
96 Tyjae Spears, Tennessee Titans
97 DeAndre Hopkins, Kansas City Chiefs
98 Austin Ekeler, Washington Commanders
99 Terry McLaurin, Washington Commanders
100 Bobby Wagner, Washington Commanders
`;

// ---- RPS Rookie Ticket Autographs (#101-142) ----
const RPS_PARALLELS = [
  P('Base'), P('Opening Kickoff Ticket'), P('FOTL Red Zone Ticket'), P('Playoff Ticket', 149), P('Divisional Ticket', 99),
  P('Ticket Stub (/97 or less)'), P('Conference Ticket', 75), P('Midfield Ticket', 50), P('Cracked Ice Ticket', 23),
  P('Week 18 Ticket', 18), P('Clear Ticket', 10), P('FOTL Goal Line Ticket', 5), P('Super Bowl Ticket', 1), P('Printing Plates', 1),
];

const rpsRookie = `
101 J.J. McCarthy, Minnesota Vikings
102 Michael Penix Jr., Atlanta Falcons
103 Brian Thomas Jr., Jacksonville Jaguars
104 Rome Odunze, Chicago Bears
105 Jordan Travis, New York Jets
106 Joe Milton III, New England Patriots
107 Xavier Legette, Carolina Panthers
108 Adonai Mitchell, Indianapolis Colts
109 Ricky Pearsall, San Francisco 49ers
110 Ladd McConkey, Los Angeles Chargers
111 Malachi Corley, New York Jets
112 Blake Corum, Los Angeles Rams
113 Troy Franklin, Denver Broncos
114 Jonathon Brooks, Carolina Panthers
115 Braelon Allen, New York Jets
116 Spencer Rattler, New Orleans Saints
117 Keon Coleman, Buffalo Bills
118 Ja’Lynn Polk, New England Patriots (FIRST OFF THE LINE ONLY)
119 Trey Benson, Arizona Cardinals
120 Audric Estime, Denver Broncos
121 Luke McCaffrey, Washington Commanders
122 Bucky Irving, Tampa Bay Buccaneers
123 Dallas Turner, Minnesota Vikings
124 Roman Wilson, Pittsburgh Steelers
125 MarShawn Lloyd, Green Bay Packers (FIRST OFF THE LINE ONLY)
126 Ja’Tavion Sanders, Carolina Panthers
127 Will Shipley, Philadelphia Eagles (FIRST OFF THE LINE ONLY)
128 Michael Pratt, Green Bay Packers
129 Laiatu Latu, Indianapolis Colts
130 Cade Stover, Houston Texans
131 Jalen McMillan, Tampa Bay Buccaneers
132 Jaylen Wright, Miami Dolphins
133 Johnny Wilson, Philadelphia Eagles
134 Brenden Rice, Los Angeles Chargers
135 Jermaine Burton, Cincinnati Bengals
136 Ben Sinnott, Washington Commanders
137 Ray Davis, Buffalo Bills
138 Isaac Guerendo, San Francisco 49ers
139 Jacob Cowing, San Francisco 49ers
140 Anthony Gould, Indianapolis Colts
141 Devin Leary, Baltimore Ravens
142 Javon Baker, New England Patriots
`;

// ---- Rookie Ticket Autographs (#143-302) ----
const ROOKIE_TICKET_PARALLELS = [
  P('Base'), P('Opening Kickoff Ticket'), P('Playoff Ticket', 149), P('Divisional Ticket', 99), P('Ticket Stub (/99 or less)'),
  P('Conference Ticket', 75), P('Midfield Ticket', 50), P('Cracked Ice Ticket', 25), P('Week 18 Ticket', 18),
  P('Clear Ticket', 10), P('Super Bowl Ticket', 1), P('Printing Plates', 1),
];

const rookieTicket = `
143 Taulia Tagovailoa, Seattle Seahawks
144 Kool-Aid McKinstry, New Orleans Saints (NO BASE)
145 Chop Robinson, Miami Dolphins (NO BASE)
147 Jared Verse, Los Angeles Rams
148 Sam Hartman, Washington Commanders (NO BASE)
149 Jamari Thrash, Cleveland Browns (NO BASE)
150 Nate Wiggins, Baltimore Ravens
151 Dillon Johnson, Carolina Panthers
152 Cooper DeJean, Philadelphia Eagles (NO BASE)
153 Tyler Nubin, New York Giants
154 Jaheim Bell, New England Patriots
155 Frank Gore Jr., Buffalo Bills
156 Leonard Taylor III, New York Jets
157 Jason Bean, Indianapolis Colts
158 Xavier Weaver, Arizona Cardinals
160 Austin Reed, Chicago Bears
164 Malik Washington, Miami Dolphins (NO BASE)
165 Olumuyiwa Fashanu, New York Jets
166 Joe Alt, Los Angeles Chargers
169 Tyler Guyton, Dallas Cowboys
170 Keilan Robinson, Jacksonville Jaguars (NO BASE)
171 Tip Reiman, Arizona Cardinals
172 Mike Sainristil, Washington Commanders (NO BASE)
175 Kris Jenkins, Cincinnati Bengals (NO BASE)
176 Isaiah Davis, New York Jets
177 Kendall Milton, Philadelphia Eagles
178 Kamren Kinchens, Los Angeles Rams
179 Tyrone Tracy Jr., New York Giants
180 Jase McClellan, Atlanta Falcons (NO BASE)
181 Jordan Whittington, Los Angeles Rams (NO BASE)
182 Graham Barton, Tampa Bay Buccaneers
183 Bralen Trice, Atlanta Falcons (NO BASE)
184 Amarius Mims, Cincinnati Bengals (NO BASE)
186 Troy Fautanu, Pittsburgh Steelers
187 Jared Wiley, Kansas City Chiefs
188 Kimani Vidal, Los Angeles Chargers
191 Ainias Smith, Philadelphia Eagles
193 Adisa Isaac, Baltimore Ravens (NO BASE)
194 Darius Robinson, Arizona Cardinals
195 Jer’Zhan Newton, Washington Commanders (NO BASE)
196 Tarheeb Still, Los Angeles Chargers
197 Kalen King, Green Bay Packers
198 Jake Bates, Detroit Lions
200 Dwight McGlothern, Minnesota Vikings
201 Jabari Small, Tennessee Titans
202 Chris Braswell, Tampa Bay Buccaneers
203 Jack Westover, Seattle Seahawks
204 Jha’Quan Jackson, Tennessee Titans
205 Trevin Wallace, Carolina Panthers
206 Mohamed Kamara, Miami Dolphins
207 Brevyn Spann-Ford, Dallas Cowboys
208 Renardo Green, San Francisco 49ers
209 Jaylan Ford, New Orleans Saints (NO BASE)
210 Austin Jones, Washington Commanders
211 Javon Solomon, Buffalo Bills
212 Calen Bullock, Houston Texans
214 Tommy Eichenberg, Las Vegas Raiders
215 Braden Fiske, Los Angeles Rams (NO BASE)
216 Jaden Hicks, Kansas City Chiefs
217 Junior Colson, Los Angeles Chargers
218 Brandon Dorlus, Atlanta Falcons (NO BASE)
226 Cornelius Johnson, Los Angeles Chargers
227 Dallin Holker, New Orleans Saints
228 Patrick Paul, Miami Dolphins
229 Sedrick Van Pran, Buffalo Bills
230 Zach Frazier, Pittsburgh Steelers
231 Zak Zinter, Cleveland Browns
232 AJ Barner, Seattle Seahawks
233 Beau Brade, Baltimore Ravens
234 C.J. Hanson, Kansas City Chiefs
235 Dadrion Taylor-Demerson, Arizona Cardinals
236 Daequan Hardy, Buffalo Bills
237 Darius Muasau, New York Giants
238 Decamerion Richardson, Las Vegas Raiders
239 Dylan McMahon, Philadelphia Eagles
240 Edefuan Ulofoshio, Buffalo Bills
241 Evan Williams, Green Bay Packers
242 Fabien Lovett, Kansas City Chiefs
243 JD Bertrand, Atlanta Falcons
244 Jordan Magee, Washington Commanders
245 Joshua Karty, Los Angeles Rams
246 Justin Eboigbe, Los Angeles Chargers
247 Justin Rogers, Cincinnati Bengals
248 Kiran Amegadjie, Chicago Bears
249 Marcellas Dial, New England Patriots
250 Myles Harden, Cleveland Browns
251 Roger Rosengarten, Baltimore Ravens
252 Will Reichard, Minnesota Vikings (NO BASE)
253 Carson Steele, Kansas City Chiefs
254 Javon Foster, Jacksonville Jaguars
255 Richard Jibunor, Seattle Seahawks
256 Tykee Smith, Tampa Bay Buccaneers
257 Gabriel Murphy, Minnesota Vikings (NO BASE)
258 Grayson Murphy, Miami Dolphins
259 Jarrian Jones, Jacksonville Jaguars
262 Elijah Jones, Arizona Cardinals
264 McKinnley Jackson, Cincinnati Bengals
265 DeWayne Carter, Buffalo Bills
266 Caelen Carson, Dallas Cowboys (NO BASE)
268 Gabe Hall, Philadelphia Eagles
269 Josh Newton, Cincinnati Bengals
272 Kitan Oladapo, Green Bay Packers
277 Jaylin Simpson, Indianapolis Colts
280 Tanner McLachlan, Cincinnati Bengals
282 Matt Goncalves, Indianapolis Colts
283 Blake Watson, Denver Broncos
284 Sataoa Laumea, Seattle Seahawks
285 Sione Vaki, Detroit Lions
287 Tanor Bortolini, Indianapolis Colts
288 Nelson Ceaser, Seattle Seahawks
289 Aaron Shampklin, Pittsburgh Steelers
290 Javion Cohen, Cleveland Browns
291 Tyler Davis, Los Angeles Rams
292 Brennan Jackson, Los Angeles Rams
293 Christian Jones, Arizona Cardinals
294 Delmar Glaze, Las Vegas Raiders
295 Kingsley Eguakun, Detroit Lions
296 Cam Little, Jacksonville Jaguars
297 Jackson Powers-Johnson, Las Vegas Raiders
298 Austin Booker, Chicago Bears
299 Andrew Coker, Las Vegas Raiders
300 Khalid Duke, Tennessee Titans
302 Tory Taylor, Chicago Bears
`;

// ---- Ticket Stub (245 numbered cards, per-card print runs) ----
const ticketStub = `
1 Trey McBride, Arizona Cardinals /85
2 James Conner, Arizona Cardinals /6
3 Kyler Murray, Arizona Cardinals /1
4 Kirk Cousins, Atlanta Falcons /18
5 Drake London, Atlanta Falcons /5
6 Bijan Robinson, Atlanta Falcons /7
7 Lamar Jackson, Baltimore Ravens /8
8 Zay Flowers, Baltimore Ravens /4
9 Derrick Henry, Baltimore Ravens /22
10 James Cook, Buffalo Bills /4
11 Josh Allen, Buffalo Bills /17
12 Dalton Kincaid, Buffalo Bills /86
13 Josey Jewell, Carolina Panthers /47
14 Bryce Young, Carolina Panthers /9
15 Adam Thielen, Carolina Panthers /19
16 D’Andre Swift, Chicago Bears /4
17 Keenan Allen, Chicago Bears /13
18 DJ Moore, Chicago Bears /2
19 Trey Hendrickson, Cincinnati Bengals /91
20 Joe Burrow, Cincinnati Bengals /9
21 Ja’Marr Chase, Cincinnati Bengals /1
22 Amari Cooper, Buffalo Bills /18
23 Nick Chubb, Cleveland Browns /24
24 Myles Garrett, Cleveland Browns /95
25 Dak Prescott, Dallas Cowboys /4
26 CeeDee Lamb, Dallas Cowboys /88
27 Micah Parsons, Dallas Cowboys /11
28 Courtland Sutton, Denver Broncos /14
29 Javonte Williams, Denver Broncos /33
30 Patrick Surtain II, Denver Broncos /2
31 Jared Goff, Detroit Lions /16
32 Jahmyr Gibbs, Detroit Lions /26
33 Amon-Ra St. Brown, Detroit Lions /14
34 Aidan Hutchinson, Detroit Lions /97
35 Josh Jacobs, Green Bay Packers /8
36 Christian Watson, Green Bay Packers /9
37 Jordan Love, Green Bay Packers /10
38 Jaire Alexander, Green Bay Packers /23
39 C.J. Stroud, Houston Texans /7
40 Stefon Diggs, Houston Texans /1
41 Nico Collins, Houston Texans /12
42 Anthony Richardson, Indianapolis Colts /5
43 Jonathan Taylor, Indianapolis Colts /28
44 Zaire Franklin, Indianapolis Colts /44
45 Evan Engram, Jacksonville Jaguars /17
46 Trevor Lawrence, Jacksonville Jaguars /16
47 Travis Etienne Jr., Jacksonville Jaguars /1
48 Travis Kelce, Kansas City Chiefs /87
49 Harrison Butker, Kansas City Chiefs /7
50 Patrick Mahomes II, Kansas City Chiefs /15
51 George Karlaftis, Kansas City Chiefs /56
52 Maxx Crosby, Las Vegas Raiders /98
53 Gardner Minshew II, Las Vegas Raiders /15
54 Davante Adams, New York Jets /17
55 Justin Herbert, Los Angeles Chargers /10
56 Josh Palmer, Los Angeles Chargers /5
57 Khalil Mack, Los Angeles Chargers /52
58 Cooper Kupp, Los Angeles Rams /10
59 Puka Nacua, Los Angeles Rams /17
60 Kyren Williams, Los Angeles Rams /23
61 Tua Tagovailoa, Miami Dolphins /1
62 Tyreek Hill, Miami Dolphins /10
63 Jaylen Waddle, Miami Dolphins /17
64 Aaron Jones, Minnesota Vikings /33
65 Justin Jefferson, Minnesota Vikings /18
66 Harrison Smith, Minnesota Vikings /22
67 Jacoby Brissett, New England Patriots /7
68 Rhamondre Stevenson, New England Patriots /38
69 Kendrick Bourne, New England Patriots /84
70 Chris Olave, New Orleans Saints /12
71 Alvin Kamara, New Orleans Saints /41
72 Derek Carr, New Orleans Saints /4
73 Daniel Jones, New York Giants /8
74 Brian Burns, New York Giants /1
75 Darius Slayton, New York Giants /86
76 Breece Hall, New York Jets /20
77 Garrett Wilson, New York Jets /5
78 Aaron Rodgers, New York Jets /8
79 Jalen Hurts, Philadelphia Eagles /1
80 Saquon Barkley, Philadelphia Eagles /26
81 A.J. Brown, Philadelphia Eagles /11
82 Russell Wilson, Pittsburgh Steelers /3
83 T.J. Watt, Pittsburgh Steelers /90
84 Pat Freiermuth, Pittsburgh Steelers /88
85 George Kittle, San Francisco 49ers /85
86 Christian McCaffrey, San Francisco 49ers /23
87 Deebo Samuel, San Francisco 49ers /1
88 Brock Purdy, San Francisco 49ers /13
89 Kenneth Walker III, Seattle Seahawks /9
90 Tyler Lockett, Seattle Seahawks /16
91 DK Metcalf, Seattle Seahawks /14
92 Baker Mayfield, Tampa Bay Buccaneers /6
93 Mike Evans, Tampa Bay Buccaneers /13
94 Rachaad White, Tampa Bay Buccaneers /1
95 Will Levis, Tennessee Titans /8
96 Tyjae Spears, Tennessee Titans /2
97 DeAndre Hopkins, Kansas City Chiefs /8
98 Austin Ekeler, Washington Commanders /30
99 Terry McLaurin, Washington Commanders /17
100 Bobby Wagner, Washington Commanders /54
101 J.J. McCarthy, Minnesota Vikings /9
102 Michael Penix Jr., Atlanta Falcons /9
103 Brian Thomas Jr., Jacksonville Jaguars /7
104 Rome Odunze, Chicago Bears /15
105 Jordan Travis, New York Jets /3
106 Joe Milton III, New England Patriots /19
107 Xavier Legette, Carolina Panthers /17
108 Adonai Mitchell, Indianapolis Colts /10
109 Ricky Pearsall, San Francisco 49ers /14
110 Ladd McConkey, Los Angeles Chargers /15
111 Malachi Corley, New York Jets /17
112 Blake Corum, Los Angeles Rams /22
113 Troy Franklin, Denver Broncos /16
114 Jonathon Brooks, Carolina Panthers /24
115 Braelon Allen, New York Jets /1
116 Spencer Rattler, New Orleans Saints /18
117 Keon Coleman, Buffalo Bills /1
119 Trey Benson, Arizona Cardinals /33
120 Audric Estime, Denver Broncos /37
121 Luke McCaffrey, Washington Commanders /12
122 Bucky Irving, Tampa Bay Buccaneers /7
123 Dallas Turner, Minnesota Vikings /15
124 Roman Wilson, Pittsburgh Steelers /10
126 Ja’Tavion Sanders, Carolina Panthers /85
128 Michael Pratt, Green Bay Packers /17
129 Laiatu Latu, Indianapolis Colts /97
130 Cade Stover, Houston Texans /87
131 Jalen McMillan, Tampa Bay Buccaneers /15
132 Jaylen Wright, Miami Dolphins /25
133 Johnny Wilson, Philadelphia Eagles /89
134 Brenden Rice, Los Angeles Chargers /82
135 Jermaine Burton, Cincinnati Bengals /81
136 Ben Sinnott, Washington Commanders /82
137 Ray Davis, Buffalo Bills /22
138 Isaac Guerendo, San Francisco 49ers /49
139 Jacob Cowing, San Francisco 49ers /83
140 Anthony Gould, Indianapolis Colts /6
141 Devin Leary, Baltimore Ravens /13
142 Javon Baker, New England Patriots /6
143 Taulia Tagovailoa, Seattle Seahawks /4
147 Jared Verse, Los Angeles Rams /8
149 Jamari Thrash, Cleveland Browns /80
150 Nate Wiggins, Baltimore Ravens /2
151 Dillon Johnson, Carolina Panthers /35
153 Tyler Nubin, New York Giants /31
154 Jaheim Bell, New England Patriots /88
155 Frank Gore Jr., Buffalo Bills /20
156 Leonard Taylor III, New York Jets /96
157 Jason Bean, Indianapolis Colts /8
158 Xavier Weaver, Arizona Cardinals /89
160 Austin Reed, Chicago Bears /16
165 Olumuyiwa Fashanu, New York Jets /74
166 Joe Alt, Los Angeles Chargers /76
169 Tyler Guyton, Dallas Cowboys /60
171 Tip Reiman, Arizona Cardinals /87
172 Mike Sainristil, Washington Commanders /1
176 Isaiah Davis, New York Jets /32
177 Kendall Milton, Philadelphia Eagles /36
178 Kamren Kinchens, Los Angeles Rams /26
179 Tyrone Tracy Jr., New York Giants /29
182 Graham Barton, Tampa Bay Buccaneers /62
186 Troy Fautanu, Pittsburgh Steelers /76
187 Jared Wiley, Kansas City Chiefs /12
188 Kimani Vidal, Los Angeles Chargers /30
191 Ainias Smith, Philadelphia Eagles /82
194 Darius Robinson, Arizona Cardinals /56
196 Tarheeb Still, Los Angeles Chargers /29
197 Kalen King, Green Bay Packers /34
198 Jake Bates, Detroit Lions /39
200 Dwight McGlothern, Minnesota Vikings /29
201 Jabari Small, Tennessee Titans /31
202 Chris Braswell, Tampa Bay Buccaneers /43
203 Jack Westover, Seattle Seahawks /87
204 Jha’Quan Jackson, Tennessee Titans /19
205 Trevin Wallace, Carolina Panthers /56
206 Mohamed Kamara, Miami Dolphins /50
207 Brevyn Spann-Ford, Dallas Cowboys /89
208 Renardo Green, San Francisco 49ers /1
209 Jaylan Ford, New Orleans Saints /53
210 Austin Jones, Washington Commanders /6
211 Javon Solomon, Buffalo Bills /56
212 Calen Bullock, Houston Texans /21
214 Tommy Eichenberg, Las Vegas Raiders /45
216 Jaden Hicks, Kansas City Chiefs /21
217 Junior Colson, Los Angeles Chargers /25
226 Cornelius Johnson, Los Angeles Chargers /83
227 Dallin Holker, New Orleans Saints /85
228 Patrick Paul, Miami Dolphins /52
229 Sedrick Van Pran, Buffalo Bills /62
230 Zach Frazier, Pittsburgh Steelers /54
231 Zak Zinter, Cleveland Browns /70
232 AJ Barner, Seattle Seahawks /88
233 Beau Brade, Baltimore Ravens /24
234 C.J. Hanson, Kansas City Chiefs /61
235 Dadrion Taylor-Demerson, Arizona Cardinals /42
236 Daequan Hardy, Buffalo Bills /25
237 Darius Muasau, New York Giants /53
238 Decamerion Richardson, Las Vegas Raiders /25
239 Dylan McMahon, Philadelphia Eagles /63
240 Edefuan Ulofoshio, Buffalo Bills /48
241 Evan Williams, Green Bay Packers /33
242 Fabien Lovett, Kansas City Chiefs /99
243 JD Bertrand, Atlanta Falcons /40
244 Jordan Magee, Washington Commanders /58
245 Joshua Karty, Los Angeles Rams /16
246 Justin Eboigbe, Los Angeles Chargers /92
247 Justin Rogers, Cincinnati Bengals /53
248 Kiran Amegadjie, Chicago Bears /72
249 Marcellas Dial, New England Patriots /27
250 Myles Harden, Cleveland Browns /26
251 Roger Rosengarten, Baltimore Ravens /70
253 Carson Steele, Kansas City Chiefs /42
254 Javon Foster, Jacksonville Jaguars /62
255 Richard Jibunor, Seattle Seahawks /50
256 Tykee Smith, Tampa Bay Buccaneers /23
258 Grayson Murphy, Miami Dolphins /59
259 Jarrian Jones, Jacksonville Jaguars /22
262 Elijah Jones, Arizona Cardinals /28
264 McKinnley Jackson, Cincinnati Bengals /93
265 DeWayne Carter, Buffalo Bills /90
266 Caelen Carson, Dallas Cowboys /21
268 Gabe Hall, Philadelphia Eagles /96
269 Josh Newton, Cincinnati Bengals /28
272 Kitan Oladapo, Green Bay Packers /27
277 Jaylin Simpson, Indianapolis Colts /30
280 Tanner McLachlan, Cincinnati Bengals /84
282 Matt Goncalves, Indianapolis Colts /71
283 Blake Watson, Denver Broncos /25
284 Sataoa Laumea, Seattle Seahawks /63
285 Sione Vaki, Detroit Lions /33
287 Tanor Bortolini, Indianapolis Colts /60
288 Nelson Ceaser, Seattle Seahawks /46
289 Aaron Shampklin, Pittsburgh Steelers /33
290 Javion Cohen, Cleveland Browns /67
291 Tyler Davis, Los Angeles Rams /90
292 Brennan Jackson, Los Angeles Rams /44
293 Christian Jones, Arizona Cardinals /75
294 Delmar Glaze, Las Vegas Raiders /71
295 Kingsley Eguakun, Detroit Lions /65
296 Cam Little, Jacksonville Jaguars /39
297 Jackson Powers-Johnson, Las Vegas Raiders /58
298 Austin Booker, Chicago Bears /94
299 Andrew Coker, Las Vegas Raiders /79
300 Khalid Duke, Tennessee Titans /47
302 Tory Taylor, Chicago Bears /19
`;

// ---- Rookie Ticket Autographs Opening Kickoff Ticket (98) ----
const okt = `
143 Taulia Tagovailoa, Seattle Seahawks
150 Nate Wiggins, Baltimore Ravens
151 Dillon Johnson, Carolina Panthers
153 Tyler Nubin, New York Giants
154 Jaheim Bell, New England Patriots
155 Frank Gore Jr., Buffalo Bills
156 Leonard Taylor III, New York Jets
157 Jason Bean, Indianapolis Colts
160 Austin Reed, Chicago Bears
165 Olumuyiwa Fashanu, New York Jets
169 Tyler Guyton, Dallas Cowboys
171 Tip Reiman, Arizona Cardinals
176 Isaiah Davis, New York Jets
177 Kendall Milton, Philadelphia Eagles
178 Kamren Kinchens, Los Angeles Rams
179 Tyrone Tracy Jr., New York Giants
181 Jordan Whittington, Los Angeles Rams
182 Graham Barton, Tampa Bay Buccaneers
186 Troy Fautanu, Pittsburgh Steelers
187 Jared Wiley, Kansas City Chiefs
188 Kimani Vidal, Los Angeles Chargers
191 Ainias Smith, Philadelphia Eagles
194 Darius Robinson, Arizona Cardinals
196 Tarheeb Still, Los Angeles Chargers
197 Kalen King, Green Bay Packers
198 Jake Bates, Detroit Lions
200 Dwight McGlothern, Minnesota Vikings
201 Jabari Small, Tennessee Titans
202 Chris Braswell, Tampa Bay Buccaneers
203 Jack Westover, Seattle Seahawks
204 Jha’Quan Jackson, Tennessee Titans
205 Trevin Wallace, Carolina Panthers
206 Mohamed Kamara, Miami Dolphins
207 Brevyn Spann-Ford, Dallas Cowboys
208 Renardo Green, San Francisco 49ers
210 Austin Jones, Washington Commanders
211 Javon Solomon, Buffalo Bills
212 Calen Bullock, Houston Texans
214 Tommy Eichenberg, Las Vegas Raiders
216 Jaden Hicks, Kansas City Chiefs
217 Junior Colson, Los Angeles Chargers
226 Cornelius Johnson, Los Angeles Chargers
227 Dallin Holker, New Orleans Saints
228 Patrick Paul, Miami Dolphins
229 Sedrick Van Pran, Buffalo Bills
230 Zach Frazier, Pittsburgh Steelers
231 Zak Zinter, Cleveland Browns
232 AJ Barner, Seattle Seahawks
233 Beau Brade, Baltimore Ravens
234 C.J. Hanson, Kansas City Chiefs
235 Dadrion Taylor-Demerson, Arizona Cardinals
236 Daequan Hardy, Buffalo Bills
237 Darius Muasau, New York Giants
238 Decamerion Richardson, Las Vegas Raiders
239 Dylan McMahon, Philadelphia Eagles
240 Edefuan Ulofoshio, Buffalo Bills
241 Evan Williams, Green Bay Packers
242 Fabien Lovett, Kansas City Chiefs
243 JD Bertrand, Atlanta Falcons
244 Jordan Magee, Washington Commanders
245 Joshua Karty, Los Angeles Rams
246 Justin Eboigbe, Los Angeles Chargers
247 Justin Rogers, Cincinnati Bengals
248 Kiran Amegadjie, Chicago Bears
249 Marcellas Dial, New England Patriots
250 Myles Harden, Cleveland Browns
251 Roger Rosengarten, Baltimore Ravens
253 Carson Steele, Kansas City Chiefs
254 Javon Foster, Jacksonville Jaguars
255 Richard Jibunor, Seattle Seahawks
256 Tykee Smith, Tampa Bay Buccaneers
258 Grayson Murphy, Miami Dolphins
259 Jarrian Jones, Jacksonville Jaguars
262 Elijah Jones, Arizona Cardinals
265 DeWayne Carter, Buffalo Bills
268 Gabe Hall, Philadelphia Eagles
269 Josh Newton, Cincinnati Bengals
272 Kitan Oladapo, Green Bay Packers
277 Jaylin Simpson, Indianapolis Colts
280 Tanner McLachlan, Cincinnati Bengals
282 Matt Goncalves, Indianapolis Colts
283 Blake Watson, Denver Broncos
284 Sataoa Laumea, Seattle Seahawks
285 Sione Vaki, Detroit Lions
287 Tanor Bortolini, Indianapolis Colts
289 Aaron Shampklin, Pittsburgh Steelers
290 Javion Cohen, Cleveland Browns
291 Tyler Davis, Los Angeles Rams
292 Brennan Jackson, Los Angeles Rams
293 Christian Jones, Arizona Cardinals
294 Delmar Glaze, Las Vegas Raiders
295 Kingsley Eguakun, Detroit Lions
296 Cam Little, Jacksonville Jaguars
297 Jackson Powers-Johnson, Las Vegas Raiders
298 Austin Booker, Chicago Bears
299 Andrew Coker, Las Vegas Raiders
300 Khalid Duke, Tennessee Titans
302 Tory Taylor, Chicago Bears
`;

// ---- Rookie Ticket Autographs Playoff Ticket /149 (104) ----
const playoff149 = `
143 Taulia Tagovailoa, Seattle Seahawks
147 Jared Verse, Los Angeles Rams
149 Jamari Thrash, Cleveland Browns
150 Nate Wiggins, Baltimore Ravens
151 Dillon Johnson, Carolina Panthers
153 Tyler Nubin, New York Giants
154 Jaheim Bell, New England Patriots
155 Frank Gore Jr., Buffalo Bills
156 Leonard Taylor III, New York Jets
157 Jason Bean, Indianapolis Colts
158 Xavier Weaver, Arizona Cardinals
160 Austin Reed, Chicago Bears
165 Olumuyiwa Fashanu, New York Jets
166 Joe Alt, Los Angeles Chargers
169 Tyler Guyton, Dallas Cowboys
171 Tip Reiman, Arizona Cardinals
176 Isaiah Davis, New York Jets
177 Kendall Milton, Philadelphia Eagles
178 Kamren Kinchens, Los Angeles Rams
179 Tyrone Tracy Jr., New York Giants
182 Graham Barton, Tampa Bay Buccaneers
186 Troy Fautanu, Pittsburgh Steelers
187 Jared Wiley, Kansas City Chiefs
188 Kimani Vidal, Los Angeles Chargers
191 Ainias Smith, Philadelphia Eagles
194 Darius Robinson, Arizona Cardinals
196 Tarheeb Still, Los Angeles Chargers
197 Kalen King, Green Bay Packers
198 Jake Bates, Detroit Lions
200 Dwight McGlothern, Minnesota Vikings
201 Jabari Small, Tennessee Titans
202 Chris Braswell, Tampa Bay Buccaneers
203 Jack Westover, Seattle Seahawks
204 Jha’Quan Jackson, Tennessee Titans
205 Trevin Wallace, Carolina Panthers
206 Mohamed Kamara, Miami Dolphins
207 Brevyn Spann-Ford, Dallas Cowboys
208 Renardo Green, San Francisco 49ers
210 Austin Jones, Washington Commanders
211 Javon Solomon, Buffalo Bills
212 Calen Bullock, Houston Texans
214 Tommy Eichenberg, Las Vegas Raiders
216 Jaden Hicks, Kansas City Chiefs
217 Junior Colson, Los Angeles Chargers
226 Cornelius Johnson, Los Angeles Chargers
227 Dallin Holker, New Orleans Saints
228 Patrick Paul, Miami Dolphins
229 Sedrick Van Pran, Buffalo Bills
230 Zach Frazier, Pittsburgh Steelers
231 Zak Zinter, Cleveland Browns
232 AJ Barner, Seattle Seahawks
233 Beau Brade, Baltimore Ravens
234 C.J. Hanson, Kansas City Chiefs
235 Dadrion Taylor-Demerson, Arizona Cardinals
236 Daequan Hardy, Buffalo Bills
237 Darius Muasau, New York Giants
238 Decamerion Richardson, Las Vegas Raiders
239 Dylan McMahon, Philadelphia Eagles
240 Edefuan Ulofoshio, Buffalo Bills
241 Evan Williams, Green Bay Packers
242 Fabien Lovett, Kansas City Chiefs
243 JD Bertrand, Atlanta Falcons
244 Jordan Magee, Washington Commanders
245 Joshua Karty, Los Angeles Rams
246 Justin Eboigbe, Los Angeles Chargers
247 Justin Rogers, Cincinnati Bengals
248 Kiran Amegadjie, Chicago Bears
249 Marcellas Dial, New England Patriots
250 Myles Harden, Cleveland Browns
251 Roger Rosengarten, Baltimore Ravens
253 Carson Steele, Kansas City Chiefs
254 Javon Foster, Jacksonville Jaguars
255 Richard Jibunor, Seattle Seahawks
256 Tykee Smith, Tampa Bay Buccaneers
258 Grayson Murphy, Miami Dolphins
259 Jarrian Jones, Jacksonville Jaguars
262 Elijah Jones, Arizona Cardinals
264 McKinnley Jackson, Cincinnati Bengals
265 DeWayne Carter, Buffalo Bills
266 Caelen Carson, Dallas Cowboys
268 Gabe Hall, Philadelphia Eagles
269 Josh Newton, Cincinnati Bengals
272 Kitan Oladapo, Green Bay Packers
277 Jaylin Simpson, Indianapolis Colts
280 Tanner McLachlan, Cincinnati Bengals
282 Matt Goncalves, Indianapolis Colts
283 Blake Watson, Denver Broncos
284 Sataoa Laumea, Seattle Seahawks
285 Sione Vaki, Detroit Lions
287 Tanor Bortolini, Indianapolis Colts
288 Nelson Ceaser, Seattle Seahawks
289 Aaron Shampklin, Pittsburgh Steelers
290 Javion Cohen, Cleveland Browns
291 Tyler Davis, Los Angeles Rams
292 Brennan Jackson, Los Angeles Rams
293 Christian Jones, Arizona Cardinals
294 Delmar Glaze, Las Vegas Raiders
295 Kingsley Eguakun, Detroit Lions
296 Cam Little, Jacksonville Jaguars
297 Jackson Powers-Johnson, Las Vegas Raiders
298 Austin Booker, Chicago Bears
299 Andrew Coker, Las Vegas Raiders
300 Khalid Duke, Tennessee Titans
302 Tory Taylor, Chicago Bears
`;

// ---- RPS Rookie Ticket Autograph Variations (42, #101-142) ----
const rpsVariations = `
101 J.J. McCarthy, Minnesota Vikings
102 Michael Penix Jr., Atlanta Falcons
103 Brian Thomas Jr., Jacksonville Jaguars
104 Rome Odunze, Chicago Bears
105 Jordan Travis, New York Jets
106 Joe Milton III, New England Patriots
107 Xavier Legette, Carolina Panthers
108 Adonai Mitchell, Indianapolis Colts
109 Ricky Pearsall, San Francisco 49ers
110 Ladd McConkey, Los Angeles Chargers
111 Malachi Corley, New York Jets
112 Blake Corum, Los Angeles Rams
113 Troy Franklin, Denver Broncos
114 Jonathon Brooks, Carolina Panthers
115 Braelon Allen, New York Jets
116 Spencer Rattler, New Orleans Saints
117 Keon Coleman, Buffalo Bills
118 Ja’Lynn Polk, New England Patriots (FIRST OFF THE LINE ONLY)
119 Trey Benson, Arizona Cardinals
120 Audric Estime, Denver Broncos
121 Luke McCaffrey, Washington Commanders
122 Bucky Irving, Tampa Bay Buccaneers
123 Dallas Turner, Minnesota Vikings
124 Roman Wilson, Pittsburgh Steelers
125 MarShawn Lloyd, Green Bay Packers (FIRST OFF THE LINE ONLY)
126 Ja’Tavion Sanders, Carolina Panthers
127 Will Shipley, Philadelphia Eagles (FIRST OFF THE LINE ONLY)
128 Michael Pratt, Green Bay Packers
129 Laiatu Latu, Indianapolis Colts
130 Cade Stover, Houston Texans
131 Jalen McMillan, Tampa Bay Buccaneers
132 Jaylen Wright, Miami Dolphins
133 Johnny Wilson, Philadelphia Eagles
134 Brenden Rice, Los Angeles Chargers
135 Jermaine Burton, Cincinnati Bengals
136 Ben Sinnott, Washington Commanders
137 Ray Davis, Buffalo Bills
138 Isaac Guerendo, San Francisco 49ers
139 Jacob Cowing, San Francisco 49ers
140 Anthony Gould, Indianapolis Colts
141 Devin Leary, Baltimore Ravens
142 Javon Baker, New England Patriots
`;

// ---- Rookie Ticket Autograph Variations (28) ----
const rookieVariations = `
143 Taulia Tagovailoa, Seattle Seahawks
144 Kool-Aid McKinstry, New Orleans Saints (NO BASE)
145 Chop Robinson, Miami Dolphins (NO BASE)
147 Jared Verse, Los Angeles Rams
148 Sam Hartman, Washington Commanders (NO BASE)
149 Jamari Thrash, Cleveland Browns (NO BASE)
150 Nate Wiggins, Baltimore Ravens
151 Dillon Johnson, Carolina Panthers
153 Tyler Nubin, New York Giants
154 Jaheim Bell, New England Patriots
155 Frank Gore Jr., Buffalo Bills
156 Leonard Taylor III, New York Jets
157 Julian Pearl, Baltimore Ravens
158 Xavier Weaver, Arizona Cardinals
160 Austin Reed, Chicago Bears
165 Olumuyiwa Fashanu, New York Jets
166 Joe Alt, Los Angeles Chargers
169 Tyler Guyton, Dallas Cowboys
170 Keilan Robinson, Jacksonville Jaguars (NO BASE)
171 Tip Reiman, Arizona Cardinals
172 Mike Sainristil, Washington Commanders (NO BASE)
175 Kris Jenkins, Cincinnati Bengals (NO BASE)
176 Isaiah Davis, New York Jets
177 Kendall Milton, Philadelphia Eagles
178 Kamren Kinchens, Los Angeles Rams
179 Tyrone Tracy Jr., New York Giants
181 Jordan Whittington, Los Angeles Rams (NO BASE)
182 Graham Barton, Tampa Bay Buccaneers
`;

// ---- Rookie Variations Ticket Stub (59, per-card print runs) ----
const rookieVariationsStub = `
101 J.J. McCarthy, Minnesota Vikings /9
102 Michael Penix Jr., Atlanta Falcons /9
103 Brian Thomas Jr., Jacksonville Jaguars /7
104 Rome Odunze, Chicago Bears /15
105 Jordan Travis, New York Jets /3
106 Joe Milton III, New England Patriots /19
107 Xavier Legette, Carolina Panthers /17
108 Adonai Mitchell, Indianapolis Colts /10
109 Ricky Pearsall, San Francisco 49ers /14
110 Ladd McConkey, Los Angeles Chargers /15
111 Malachi Corley, New York Jets /17
112 Blake Corum, Los Angeles Rams /22
113 Troy Franklin, Denver Broncos /16
114 Jonathon Brooks, Carolina Panthers /24
115 Braelon Allen, New York Jets /1
116 Spencer Rattler, New Orleans Saints /18
117 Keon Coleman, Buffalo Bills /1
119 Trey Benson, Arizona Cardinals /33
120 Audric Estime, Denver Broncos /37
121 Luke McCaffrey, Washington Commanders /12
122 Bucky Irving, Tampa Bay Buccaneers /7
123 Dallas Turner, Minnesota Vikings /15
124 Roman Wilson, Pittsburgh Steelers /10
126 Ja’Tavion Sanders, Carolina Panthers /85
128 Michael Pratt, Green Bay Packers /17
129 Laiatu Latu, Indianapolis Colts /97
130 Cade Stover, Houston Texans /87
131 Jalen McMillan, Tampa Bay Buccaneers /15
132 Jaylen Wright, Miami Dolphins /25
133 Johnny Wilson, Philadelphia Eagles /89
134 Brenden Rice, Los Angeles Chargers /82
135 Jermaine Burton, Cincinnati Bengals /81
136 Ben Sinnott, Washington Commanders /82
137 Ray Davis, Buffalo Bills /22
138 Isaac Guerendo, San Francisco 49ers /49
139 Jacob Cowing, San Francisco 49ers /83
140 Anthony Gould, Indianapolis Colts /6
141 Devin Leary, Baltimore Ravens /13
142 Javon Baker, New England Patriots /6
143 Taulia Tagovailoa, Seattle Seahawks /4
144 Kool-Aid McKinstry, New Orleans Saints /14
146 Terrion Arnold, Detroit Lions /1
147 Jared Verse, Los Angeles Rams /8
150 Nate Wiggins, Baltimore Ravens /2
151 Dillon Johnson, Carolina Panthers /35
153 Tyler Nubin, New York Giants /31
154 Jaheim Bell, New England Patriots /88
155 Frank Gore Jr., Buffalo Bills /20
156 Leonard Taylor III, New York Jets /96
158 Xavier Weaver, Arizona Cardinals /89
160 Austin Reed, Chicago Bears /16
169 Tyler Guyton, Dallas Cowboys /60
170 Keilan Robinson, Jacksonville Jaguars /31
171 Tip Reiman, Arizona Cardinals /87
176 Isaiah Davis, New York Jets /32
177 Kendall Milton, Philadelphia Eagles /36
178 Kamren Kinchens, Los Angeles Rams /26
179 Tyrone Tracy Jr., New York Giants /29
182 Graham Barton, Tampa Bay Buccaneers /62
`;

// ---- Autographs ----
const AUTO_99 = [P('Base', 99), P('Bronze', 25), P('Gold', 10), P('Platinum', 1)];

const contendersAutos = `
1 Josh Downs, Indianapolis Colts (NO BASE OR BRONZE)
2 Zay Flowers, Baltimore Ravens
3 Zach Charbonnet, Seattle Seahawks
4 Tyson Bagent, Chicago Bears
5 Tank Bigsby, Jacksonville Jaguars
6 Gervon Dexter Sr., Chicago Bears
7 Michael Wilson, Arizona Cardinals
8 Sean Clifford, Green Bay Packers
9 Tyjae Spears, Tennessee Titans (NO BASE)
10 Calvin Austin III, Pittsburgh Steelers
13 Deuce Vaughn, Dallas Cowboys
14 Khalil Shakir, Buffalo Bills
15 George Pickens, Pittsburgh Steelers (NO BASE)
16 Dorian Thompson-Robinson, Cleveland Browns
17 Tyree Wilson, Las Vegas Raiders
18 Jameson Williams, Detroit Lions
19 Kayshon Boutte, New England Patriots
20 Tre Tucker, Las Vegas Raiders
`;

const speedRed = `
1 Brett Favre, Green Bay Packers /100
3 Julius Peppers, Carolina Panthers /100
7 Kam Chancellor, Seattle Seahawks /100
8 Keyshawn Johnson, Tampa Bay Buccaneers /100
11 Mike Singletary, Chicago Bears /100
12 Rome Odunze, Chicago Bears /100
19 Joe Milton III, New England Patriots /100
20 Jordan Travis, New York Jets /100
21 David Njoku, Cleveland Browns /100
22 Adonai Mitchell, Indianapolis Colts /100
23 Xavier Legette, Carolina Panthers /100
24 Ladd McConkey, Los Angeles Chargers /100
25 Blake Corum, Los Angeles Rams /100
26 Malachi Corley, New York Jets /100
27 Jonathon Brooks, Carolina Panthers /100
28 Braelon Allen, New York Jets /100
29 Keon Coleman, Buffalo Bills /100
30 Trey Benson, Arizona Cardinals /100
31 Romeo Doubs, Green Bay Packers /100
33 Luke McCaffrey, Washington Commanders /100
34 Bucky Irving, Tampa Bay Buccaneers /100
37 Jaylen Wright, Miami Dolphins /100
38 Brenden Rice, Los Angeles Chargers /100
39 Jermaine Burton, Cincinnati Bengals /100
40 Ray Davis, Buffalo Bills /100
`;

const legendaryAutos = `
1 John Jefferson, San Diego Chargers
2 Joe Theismann, Washington Redskins
3 Gerald Riggs, Atlanta Falcons (NO BASE)
4 Deron Cherry, Kansas City Chiefs (NO BASE)
5 Joe Cribbs, Buffalo Bills
6 Rick Upchurch, Denver Broncos
7 Vance Johnson, Denver Broncos
8 Barry Foster, Pittsburgh Steelers
9 Yancey Thigpen, Pittsburgh Steelers
10 Ben Coates, Baltimore Ravens
11 Chuck Foreman, Minnesota Vikings
12 Randy Gradishar, Denver Broncos
13 Andre Ware, Detroit Lions
14 Roger Wehrli, St. Louis Cardinals
15 Deion Sanders, Dallas Cowboys
16 Vince Ferragamo, Los Angeles Rams
18 Joe DeLamielleure, Buffalo Bills
19 Tony Mandarich, Green Bay Packers
20 Wes Chandler, San Diego Chargers
21 Jon Stinchcomb, New Orleans Saints
22 Paul Krause, Minnesota Vikings
23 Jim Hart, St. Louis Cardinals
24 Dwight Stephenson, Miami Dolphins
25 Mario Manningham, New York Giants
26 Joe Staley, San Francisco 49ers (NO BASE, BRONZE, OR GOLD)
27 Jamaal Charles, Kansas City Chiefs
28 Brandon Marshall, Denver Broncos
29 Steven Jackson, St. Louis Rams (NO BASE, BRONZE, OR GOLD)
30 Peter Skoronski, Tennessee Titans
`;

const mvpAutos = `
2 Justin Jefferson, Minnesota Vikings /99
3 Justin Herbert, Los Angeles Chargers /99
4 Myles Garrett, Cleveland Browns /99
5 Jordan Love, Green Bay Packers /99
7 Anthony Richardson, Indianapolis Colts /99
10 Brock Purdy, San Francisco 49ers /99
`;

const nflInk = `
1 John Jefferson, San Diego Chargers
2 Joe Theismann, Washington Redskins
3 Gerald Riggs, Atlanta Falcons (NO BASE)
4 Deron Cherry, Kansas City Chiefs (NO BASE)
5 Joe Cribbs, Buffalo Bills
6 Rick Upchurch, Denver Broncos
7 Vance Johnson, Denver Broncos
8 Barry Foster, Pittsburgh Steelers (NO BASE)
9 Yancey Thigpen, Pittsburgh Steelers
10 Ben Coates, Baltimore Ravens
11 Chuck Foreman, Minnesota Vikings
12 Randy Gradishar, Denver Broncos
13 Andre Ware, Detroit Lions
14 Roger Wehrli, St. Louis Cardinals
15 Deion Sanders, Dallas Cowboys
16 Vince Ferragamo, Los Angeles Rams
18 Joe DeLamielleure, Buffalo Bills
19 Tony Mandarich, Green Bay Packers
20 Wes Chandler, San Diego Chargers
21 Jon Stinchcomb, New Orleans Saints
22 Paul Krause, Minnesota Vikings
23 Jim Hart, St. Louis Cardinals
24 Dwight Stephenson, Miami Dolphins
25 Mario Manningham, New York Giants
26 Joe Staley, San Francisco 49ers (NO BASE, BRONZE, GOLD)
27 Jamaal Charles, Kansas City Chiefs
28 Brandon Marshall, Denver Broncos
29 Steven Jackson, St. Louis Rams (NO BASE, BRONZE, GOLD)
30 Peter Skoronski, Tennessee Titans
31 Jordan Love, Green Bay Packers (NO BASE)
33 Myles Garrett, Cleveland Browns
34 Joe Klecko, New York Jets
35 Ed McCaffrey, Denver Broncos (NO BASE, BRONZE)
36 Al Toon, New York Jets
37 Mark van Eeghen, Oakland Raiders (NO BASE, BRONZE, GOLD)
38 Levon Kirkland, Pittsburgh Steelers
39 Johnny Manziel, Cleveland Browns
40 Ricky Williams, Miami Dolphins
`;

const rookieSwatchAutos = `
2 Adonai Mitchell, Indianapolis Colts
3 Audric Estime, Denver Broncos
4 Blake Corum, Los Angeles Rams
5 Braelon Allen, New York Jets
6 Brenden Rice, Los Angeles Chargers
7 Brian Thomas Jr., Jacksonville Jaguars
9 Bucky Irving, Tampa Bay Buccaneers
12 J.J. McCarthy, Minnesota Vikings
13 Jalen McMillan, Tampa Bay Buccaneers
14 Ja’Lynn Polk, New England Patriots
15 Ja’Tavion Sanders, Carolina Panthers
17 Jaylen Wright, Miami Dolphins
18 Jermaine Burton, Cincinnati Bengals
19 Joe Milton III, New England Patriots
20 Johnny Wilson, Philadelphia Eagles
21 Jonathon Brooks, Carolina Panthers
22 Jordan Travis, New York Jets
23 Keon Coleman, Buffalo Bills
24 Ladd McConkey, Los Angeles Chargers
25 Laiatu Latu, Indianapolis Colts
26 Luke McCaffrey, Washington Commanders
27 Malachi Corley, New York Jets
29 MarShawn Lloyd, Green Bay Packers
31 Michael Penix Jr., Atlanta Falcons
32 Carson Steele, Kansas City Chiefs
33 Ray Davis, Buffalo Bills
34 Ricky Pearsall, San Francisco 49ers
35 Roman Wilson, Pittsburgh Steelers
36 Rome Odunze, Chicago Bears
37 Spencer Rattler, New Orleans Saints
38 Trey Benson, Arizona Cardinals
39 Will Shipley, Philadelphia Eagles
40 Xavier Legette, Carolina Panthers
`;

const vetAutos = `
3 Brock Purdy, San Francisco 49ers (/10 CLEAR ONLY)
5 DeVonta Smith, Philadelphia Eagles
16 Kyle Dugger, New England Patriots
`;

const vetAutosPlayoff = `
5 DeVonta Smith, Philadelphia Eagles /49
16 Kyle Dugger, New England Patriots /149
`;
const vetAutosDivisional = `
5 DeVonta Smith, Philadelphia Eagles /30
16 Kyle Dugger, New England Patriots /99
`;
const vetAutosConference = `
5 DeVonta Smith, Philadelphia Eagles /25
16 Kyle Dugger, New England Patriots /75
`;
const vetAutosStub = `
5 DeVonta Smith, Philadelphia Eagles /6
16 Kyle Dugger, New England Patriots /23
`;
const vetRedZone = `
1 Myles Garrett, Cleveland Browns
3 Brock Purdy, San Francisco 49ers
4 Garrett Wilson, New York Jets
5 DeVonta Smith, Philadelphia Eagles
6 Terry McLaurin, Washington Commanders
7 Aaron Jones, Minnesota Vikings
10 Darius Slayton, New York Giants
13 Aidan O’Connell, Las Vegas Raiders
14 Derius Davis, Los Angeles Chargers
16 Kyle Dugger, New England Patriots
`;
const vetGoalLine = `
1 Myles Garrett, Cleveland Browns /5
5 DeVonta Smith, Philadelphia Eagles /5
7 Aaron Jones, Minnesota Vikings /5
13 Aidan O’Connell, Las Vegas Raiders /5
14 Derius Davis, Los Angeles Chargers /5
`;

// ---- Memorabilia ----
const rookieSwatches = `
1 Caleb Williams, Chicago Bears
2 Adonai Mitchell, Indianapolis Colts
3 Audric Estime, Denver Broncos
4 Blake Corum, Los Angeles Rams
5 Braelon Allen, New York Jets
6 Brenden Rice, Los Angeles Chargers
7 Brian Thomas Jr., Jacksonville Jaguars
8 Brock Bowers, Las Vegas Raiders
9 Bucky Irving, Tampa Bay Buccaneers
10 Dallas Turner, Minnesota Vikings
11 Drake Maye, New England Patriots
12 J.J. McCarthy, Minnesota Vikings
13 Jalen McMillan, Tampa Bay Buccaneers
14 Ja’Lynn Polk, New England Patriots
15 Ja’Tavion Sanders, Carolina Panthers
16 Jayden Daniels, Washington Commanders
17 Jaylen Wright, Miami Dolphins
18 Jermaine Burton, Cincinnati Bengals
19 Joe Milton III, New England Patriots
20 Johnny Wilson, Philadelphia Eagles
21 Jonathon Brooks, Carolina Panthers
22 Jordan Travis, New York Jets
23 Keon Coleman, Buffalo Bills
24 Ladd McConkey, Los Angeles Chargers
25 Laiatu Latu, Indianapolis Colts
26 Luke McCaffrey, Washington Commanders
27 Malachi Corley, New York Jets
28 Malik Nabers, New York Giants
29 MarShawn Lloyd, Green Bay Packers
30 Marvin Harrison Jr., Arizona Cardinals
31 Michael Penix Jr., Atlanta Falcons
32 Carson Steele, Kansas City Chiefs
33 Ray Davis, Buffalo Bills
34 Ricky Pearsall, San Francisco 49ers
35 Roman Wilson, Pittsburgh Steelers
36 Rome Odunze, Chicago Bears
37 Spencer Rattler, New Orleans Saints
38 Trey Benson, Arizona Cardinals
39 Will Shipley, Philadelphia Eagles
40 Xavier Legette, Carolina Panthers
41 Xavier Worthy, Kansas City Chiefs
42 Bo Nix, Denver Broncos
`;

const dualSwatches = `
1 Jordan Travis/Malachi Corley, New York Jets/New York Jets
2 Blake Corum/J.J. McCarthy, Los Angeles Rams/Minnesota Vikings
3 Michael Penix Jr./Rome Odunze, Atlanta Falcons/Chicago Bears
4 Brian Thomas Jr./Keon Coleman, Jacksonville Jaguars/Buffalo Bills
5 Ladd McConkey/Ricky Pearsall, Los Angeles Chargers/San Francisco 49ers
6 Adonai Mitchell/Xavier Legette, Indianapolis Colts/Carolina Panthers
7 MarShawn Lloyd/Trey Benson, Green Bay Packers/Arizona Cardinals
8 Ja’Lynn Polk/Joe Milton III, New England Patriots/New England Patriots
9 Audric Estime/Troy Franklin, Denver Broncos/Denver Broncos
10 Braelon Allen/Jaylen Wright, New York Jets/Miami Dolphins
11 J.J. McCarthy/Michael Penix Jr., Minnesota Vikings/Atlanta Falcons
12 Marvin Harrison Jr./Rome Odunze, Arizona Cardinals/Chicago Bears
13 Drake Maye/Jayden Daniels, New England Patriots/Washington Commanders
14 Dallas Turner/Laiatu Latu, Minnesota Vikings/Indianapolis Colts
15 Blake Corum/Jonathon Brooks, Los Angeles Rams/Carolina Panthers
16 Brock Bowers/Cade Stover, Las Vegas Raiders/Houston Texans
`;

// ---- Inserts ----
const DRAFT_PARALLELS = [P('Base'), P('Bronze'), P('Red'), P('Teal', 149), P('Blue', 99), P('Green', 75), P('Gold', 10)];
const FOIL_PARALLELS = [P('Base'), P('Silver'), P('Cracked Ice', 25), P('Gold', 10), P('Platinum', 1)];

const contendersToCanton = `
1 Emmitt Smith, Dallas Cowboys /100
2 John Elway, Denver Broncos /100
4 Cris Carter, Minnesota Vikings /100
8 Dwight Freeney, Indianapolis Colts /100
9 Michael Irvin, Dallas Cowboys /100
`;

const crownJewels = `
1 Caleb Williams, Chicago Bears
2 Drake Maye, New England Patriots
3 Jayden Daniels, Washington Commanders
4 Brock Bowers, Las Vegas Raiders
5 Marvin Harrison Jr., Arizona Cardinals
6 Malik Nabers, New York Giants
7 Xavier Worthy, Kansas City Chiefs
8 Patrick Mahomes II, Kansas City Chiefs
9 Trevor Lawrence, Jacksonville Jaguars
10 Joe Burrow, Cincinnati Bengals
11 Justin Herbert, Los Angeles Chargers
12 C.J. Stroud, Houston Texans
13 Jared Goff, Detroit Lions
14 Jordan Love, Green Bay Packers
15 Ja’Marr Chase, Cincinnati Bengals
16 Justin Jefferson, Minnesota Vikings
17 CeeDee Lamb, Dallas Cowboys
18 Travis Kelce, Kansas City Chiefs
19 George Kittle, San Francisco 49ers
20 Micah Parsons, Dallas Cowboys
`;

const draftClass = `
1 Caleb Williams, Chicago Bears
2 Jayden Daniels, Washington Commanders
3 Drake Maye, New England Patriots
4 Marvin Harrison Jr., Arizona Cardinals
5 Malik Nabers, New York Giants
6 Xavier Worthy, Kansas City Chiefs
7 Brock Bowers, Las Vegas Raiders
8 J.J. McCarthy, Minnesota Vikings
9 Michael Penix Jr., Atlanta Falcons
10 Spencer Rattler, New Orleans Saints
11 Joe Milton III, New England Patriots
12 Trey Benson, Arizona Cardinals
13 Rome Odunze, Chicago Bears
14 Brian Thomas Jr., Jacksonville Jaguars
15 Ricky Pearsall, San Francisco 49ers
16 Xavier Legette, Carolina Panthers
17 Keon Coleman, Buffalo Bills
18 Adonai Mitchell, Indianapolis Colts
19 Jalen McMillan, Tampa Bay Buccaneers
20 Anthony Gould, Indianapolis Colts
21 Blake Corum, Los Angeles Rams
22 Audric Estime, Denver Broncos
23 Bo Nix, Denver Broncos
24 Laiatu Latu, Indianapolis Colts
25 Dallas Turner, Minnesota Vikings
`;

const galaTickets = `
1 Patrick Mahomes II, Kansas City Chiefs /8
2 Christian McCaffrey, San Francisco 49ers /8
3 Lamar Jackson, Baltimore Ravens /8
4 Joe Burrow, Cincinnati Bengals /8
5 Josh Allen, Buffalo Bills /8
6 C.J. Stroud, Houston Texans /8
7 Tyjae Spears, Tennessee Titans /8
8 Josh Jacobs, Green Bay Packers /8
9 Myles Garrett, Cleveland Browns /8
10 T.J. Watt, Pittsburgh Steelers /8
11 Micah Parsons, Dallas Cowboys /8
12 Justin Herbert, Los Angeles Chargers /8
13 Tyreek Hill, Miami Dolphins /8
14 Anthony Richardson, Indianapolis Colts /8
15 Davante Adams, Las Vegas Raiders /8
16 Malik Nabers, New York Giants /8
17 Rome Odunze, Chicago Bears /8
18 Drake Maye, New England Patriots /8
19 Jayden Daniels, Washington Commanders /8
20 Bo Nix, Denver Broncos /8
21 Brian Thomas Jr., Jacksonville Jaguars /8
22 Marvin Harrison Jr., Arizona Cardinals /8
23 Xavier Worthy, Kansas City Chiefs /8
24 Michael Penix Jr., Atlanta Falcons /8
25 J.J. McCarthy, Minnesota Vikings /8
26 Jonathon Brooks, Carolina Panthers /8
27 Blake Corum, Los Angeles Rams /8
28 Keon Coleman, Buffalo Bills /8
29 Ricky Pearsall, San Francisco 49ers /8
30 Caleb Williams, Chicago Bears /8
`;

const hallPass = `
1 Patrick Mahomes II, Kansas City Chiefs
2 Trevor Lawrence, Jacksonville Jaguars
3 Tua Tagovailoa, Miami Dolphins
4 Jordan Love, Green Bay Packers
5 Anthony Richardson, Indianapolis Colts
6 C.J. Stroud, Houston Texans
7 Jalen Hurts, Philadelphia Eagles
8 Brock Purdy, San Francisco 49ers
9 Lamar Jackson, Baltimore Ravens
10 Dak Prescott, Dallas Cowboys
11 Ja’Marr Chase, Cincinnati Bengals
12 Justin Jefferson, Minnesota Vikings
13 CeeDee Lamb, Dallas Cowboys
14 Travis Kelce, Kansas City Chiefs
15 George Kittle, San Francisco 49ers
16 Derrick Henry, Baltimore Ravens
17 Justin Herbert, Los Angeles Chargers
18 Puka Nacua, Los Angeles Rams
19 Amon-Ra St. Brown, Detroit Lions
20 T.J. Watt, Pittsburgh Steelers
21 Nick Bosa, San Francisco 49ers
22 Tyreek Hill, Miami Dolphins
23 Deebo Samuel, San Francisco 49ers
24 DK Metcalf, Seattle Seahawks
25 Christian McCaffrey, San Francisco 49ers
`;

const historicDraft = `
1 Joe Klecko/Tony Dorsett, New York Jets/Dallas Cowboys
2 Earl Campbell/James Lofton, Houston Oilers/Green Bay Packers
3 Dan Hampton/Kellen Winslow, Chicago Bears/San Diego Chargers
4 Anthony Munoz/Art Monk, Cincinnati Bengals/Washington Redskins
5 Lawrence Taylor/Mike Singletary, New York Giants/Chicago Bears
6 Andre Tippett/Marcus Allen, New England Patriots/Los Angeles Raiders
7 Dan Marino/Jim Kelly, Miami Dolphins/Buffalo Bills
8 Al Toon/Andre Reed, New York Jets/Buffalo Bills
9 Jim Harbaugh/Vinny Testaverde, Chicago Bears/Tampa Bay Buccaneers
10 Michael Irvin/Tim Brown, Dallas Cowboys/Los Angeles Raiders
11 Barry Sanders/Deion Sanders, Detroit Lions/Atlanta Falcons
12 Andre Ware/Emmitt Smith, Detroit Lions/Dallas Cowboys
13 Aeneas Williams/Brett Favre, Phoenix Cardinals/Atlanta Falcons
14 Isaac Bruce/Marshall Faulk, Los Angeles Rams/Indianapolis Colts
15 Tony Boselli/Warren Sapp, Jacksonville Jaguars/Tampa Bay Buccaneers
16 Keyshawn Johnson/Ray Lewis, New York Jets/Baltimore Ravens
17 Charles Woodson/Peyton Manning, Oakland Raiders/Indianapolis Colts
18 Champ Bailey/Edgerrin James, Washington Redskins/Indianapolis Colts
19 Drew Brees/Michael Vick, San Diego Chargers/Atlanta Falcons
20 Terrell Suggs/Troy Polamalu, Baltimore Ravens/Pittsburgh Steelers
21 Eli Manning/Steven Jackson, New York Giants/St. Louis Rams
22 Aaron Rodgers/DeMarcus Ware, Green Bay Packers/Dallas Cowboys
23 Darrelle Revis/Patrick Willis, New York Jets/San Francisco 49ers
24 Clay Matthews/Matthew Stafford, Green Bay Packers/Detroit Lions
25 Sam Bradford/Tim Tebow, St. Louis Rams/Denver Broncos
`;

const licenseToDominate = `
1 Patrick Mahomes II, Kansas City Chiefs
2 Trevor Lawrence, Jacksonville Jaguars
3 Tua Tagovailoa, Miami Dolphins
4 Jordan Love, Green Bay Packers
5 Russell Wilson, Pittsburgh Steelers
6 Anthony Richardson, Indianapolis Colts
7 C.J. Stroud, Houston Texans
8 Jalen Hurts, Philadelphia Eagles
9 Brock Purdy, San Francisco 49ers
10 Lamar Jackson, Baltimore Ravens
11 Dak Prescott, Dallas Cowboys
12 Ja’Marr Chase, Cincinnati Bengals
13 Justin Jefferson, Minnesota Vikings
14 CeeDee Lamb, Dallas Cowboys
15 Travis Kelce, Kansas City Chiefs
16 George Kittle, San Francisco 49ers
17 Derrick Henry, Baltimore Ravens
18 Justin Herbert, Los Angeles Chargers
19 Kyren Williams, Los Angeles Rams
20 Puka Nacua, Los Angeles Rams
21 Amon-Ra St. Brown, Detroit Lions
22 DaRon Bland, Dallas Cowboys
23 T.J. Watt, Pittsburgh Steelers
24 Nick Bosa, San Francisco 49ers
25 Tyreek Hill, Miami Dolphins
26 Deebo Samuel, San Francisco 49ers
27 DK Metcalf, Seattle Seahawks
28 Christian McCaffrey, San Francisco 49ers
29 Myles Garrett, Cleveland Browns
30 Chris Jones, Kansas City Chiefs
`;

const permitToDominate = `
1 Caleb Williams, Chicago Bears
2 Drake Maye, New England Patriots
3 Jayden Daniels, Washington Commanders
4 Brock Bowers, Las Vegas Raiders
5 Marvin Harrison Jr., Arizona Cardinals
6 Malik Nabers, New York Giants
7 Xavier Worthy, Kansas City Chiefs
8 Adonai Mitchell, Indianapolis Colts
9 Audric Estime, Denver Broncos
10 Blake Corum, Los Angeles Rams
11 Braelon Allen, New York Jets
12 Brenden Rice, Los Angeles Chargers
13 Bucky Irving, Tampa Bay Buccaneers
14 Dallas Turner, Minnesota Vikings
15 J.J. McCarthy, Minnesota Vikings
16 Jalen McMillan, Tampa Bay Buccaneers
17 Ja’Lynn Polk, New England Patriots
18 Ja’Tavion Sanders, Carolina Panthers
19 Jermaine Burton, Cincinnati Bengals
20 Joe Milton III, New England Patriots
21 Johnny Wilson, Philadelphia Eagles
22 Jonathon Brooks, Carolina Panthers
23 Jordan Travis, New York Jets
24 Keon Coleman, Buffalo Bills
25 Ladd McConkey, Los Angeles Chargers
26 Laiatu Latu, Indianapolis Colts
27 Luke McCaffrey, Washington Commanders
28 Malachi Corley, New York Jets
29 MarShawn Lloyd, Green Bay Packers
30 Michael Penix Jr., Atlanta Falcons
31 Kool-Aid McKinstry, New Orleans Saints
32 Spencer Rattler, New Orleans Saints
33 Trey Benson, Arizona Cardinals
34 Will Shipley, Philadelphia Eagles
35 Bo Nix, Denver Broncos
36 Ray Davis, Buffalo Bills
37 Ricky Pearsall, San Francisco 49ers
38 Rome Odunze, Chicago Bears
39 Roman Wilson, Pittsburgh Steelers
40 Brian Thomas Jr., Jacksonville Jaguars
`;

const powerPlayers = `
1 Joe Burrow/Patrick Mahomes II, Cincinnati Bengals/Kansas City Chiefs
2 Lamar Jackson/Tua Tagovailoa, Baltimore Ravens/Miami Dolphins
3 Dak Prescott/Jared Goff, Dallas Cowboys/Detroit Lions
4 Jordan Love/Josh Allen, Green Bay Packers/Buffalo Bills
5 Anthony Richardson/C.J. Stroud, Indianapolis Colts/Houston Texans
6 Baker Mayfield/Trevor Lawrence, Tampa Bay Buccaneers/Jacksonville Jaguars
7 Brock Purdy/Jalen Hurts, San Francisco 49ers/Philadelphia Eagles
8 Ja’Marr Chase/Justin Jefferson, Cincinnati Bengals/Minnesota Vikings
9 Jaylen Waddle/Tyreek Hill, Miami Dolphins/Miami Dolphins
10 Amon-Ra St. Brown/Puka Nacua, Detroit Lions/Los Angeles Rams
11 Brandon Aiyuk/Deebo Samuel, San Francisco 49ers/San Francisco 49ers
12 A.J. Brown/DJ Moore, Philadelphia Eagles/Chicago Bears
13 Amari Cooper/Mike Evans, Buffalo Bills/Tampa Bay Buccaneers
14 Davante Adams/Stefon Diggs, New York Jets/Houston Texans
15 George Kittle/Travis Kelce, San Francisco 49ers/Kansas City Chiefs
16 Nick Bosa/T.J. Watt, San Francisco 49ers/Pittsburgh Steelers
17 Derrick Henry/Josh Jacobs, Baltimore Ravens/Green Bay Packers
18 CeeDee Lamb/DeAndre Hopkins, Dallas Cowboys/Kansas City Chiefs
19 James Cook/Kyren Williams, Buffalo Bills/Los Angeles Rams
20 Brandon Aubrey/Justin Tucker, Dallas Cowboys/Baltimore Ravens
21 J.J. McCarthy/Michael Penix Jr., Minnesota Vikings/Atlanta Falcons
22 Drake Maye/Jayden Daniels, New England Patriots/Washington Commanders
23 Malik Nabers/Xavier Worthy, New York Giants/Kansas City Chiefs
24 Keon Coleman/Rome Odunze, Buffalo Bills/Chicago Bears
25 Blake Corum/Jonathon Brooks, Los Angeles Rams/Carolina Panthers
`;

const rookieOfYear = `
1 Caleb Williams, Chicago Bears
2 Jayden Daniels, Washington Commanders
3 Drake Maye, New England Patriots
4 Marvin Harrison Jr., Arizona Cardinals
5 Brock Bowers, Las Vegas Raiders
6 Xavier Worthy, Kansas City Chiefs
7 Malik Nabers, New York Giants
8 J.J. McCarthy, Minnesota Vikings
9 Michael Penix Jr., Atlanta Falcons
10 Rome Odunze, Chicago Bears
11 Adonai Mitchell, Indianapolis Colts
12 Keon Coleman, Buffalo Bills
13 Blake Corum, Los Angeles Rams
14 Dallas Turner, Minnesota Vikings
15 Brian Thomas Jr., Jacksonville Jaguars
16 Laiatu Latu, Indianapolis Colts
17 Terrion Arnold, Detroit Lions
18 Jared Verse, Los Angeles Rams
19 Bo Nix, Denver Broncos
20 Ladd McConkey, Los Angeles Chargers
`;

const rookieStallions = `
1 Caleb Williams, Chicago Bears
2 Bo Nix, Denver Broncos
3 Jayden Daniels, Washington Commanders
4 Drake Maye, New England Patriots
5 Marvin Harrison Jr., Arizona Cardinals
6 Malik Nabers, New York Giants
7 Xavier Worthy, Kansas City Chiefs
8 Brock Bowers, Las Vegas Raiders
9 J.J. McCarthy, Minnesota Vikings
10 Michael Penix Jr., Atlanta Falcons
11 Spencer Rattler, New Orleans Saints
12 Joe Milton III, New England Patriots
13 Rome Odunze, Chicago Bears
14 Brian Thomas Jr., Jacksonville Jaguars
15 Ricky Pearsall, San Francisco 49ers
16 Xavier Legette, Carolina Panthers
17 Adonai Mitchell, Indianapolis Colts
18 Ja’Lynn Polk, New England Patriots
19 Keon Coleman, Buffalo Bills
20 Luke McCaffrey, Washington Commanders
21 Blake Corum, Los Angeles Rams
22 Audric Estime, Denver Broncos
23 Jonathon Brooks, Carolina Panthers
24 MarShawn Lloyd, Green Bay Packers
25 Laiatu Latu, Indianapolis Colts
`;

const roundNumbers = `
1 Drake Maye/Jayden Daniels, New England Patriots/Washington Commanders
2 Malik Nabers/Marvin Harrison Jr., New York Giants/Arizona Cardinals
3 Michael Penix Jr./Rome Odunze, Atlanta Falcons/Chicago Bears
4 Bo Nix/J.J. McCarthy, Denver Broncos/Minnesota Vikings
5 Dallas Turner/Laiatu Latu, Minnesota Vikings/Indianapolis Colts
6 Chop Robinson/Jared Verse, Miami Dolphins/Los Angeles Rams
7 Brian Thomas Jr./Xavier Worthy, Jacksonville Jaguars/Kansas City Chiefs
8 Ricky Pearsall/Xavier Legette, San Francisco 49ers/Carolina Panthers
9 Keon Coleman/Ladd McConkey, Buffalo Bills/Los Angeles Chargers
10 Adonai Mitchell/Ja’Lynn Polk, Indianapolis Colts/New England Patriots
11 Cooper DeJean/Kool-Aid McKinstry, Philadelphia Eagles/New Orleans Saints
12 Blake Corum/Trey Benson, Los Angeles Rams/Arizona Cardinals
13 Jermaine Burton/Roman Wilson, Cincinnati Bengals/Pittsburgh Steelers
14 Luke McCaffrey/MarShawn Lloyd, Washington Commanders/Green Bay Packers
15 Jacob Cowing/Troy Franklin, San Francisco 49ers/Denver Broncos
16 Braelon Allen/Bucky Irving, New York Jets/Tampa Bay Buccaneers
17 Isaac Guerendo/Jaylen Wright, San Francisco 49ers/Miami Dolphins
18 Audric Estime/Spencer Rattler, Denver Broncos/New Orleans Saints
19 Anthony Gould/Jordan Travis, Indianapolis Colts/New York Jets
20 Johnny Wilson/Malik Washington, Philadelphia Eagles/Miami Dolphins
21 Devin Leary/Jordan Whittington, Baltimore Ravens/Los Angeles Rams
22 Brenden Rice/Jaheim Bell, Los Angeles Chargers/New England Patriots
23 Brock Bowers/Terrion Arnold, Las Vegas Raiders/Detroit Lions
24 Byron Murphy II/Quinyon Mitchell, Seattle Seahawks/Philadelphia Eagles
25 Ben Sinnott/Jonathon Brooks, Washington Commanders/Carolina Panthers
`;

const supernatural = `
1 Patrick Mahomes II, Kansas City Chiefs
2 C.J. Stroud, Houston Texans
3 Anthony Richardson, Indianapolis Colts
4 Jalen Hurts, Philadelphia Eagles
5 Josh Allen, Buffalo Bills
6 Tyreek Hill, Miami Dolphins
7 Justin Jefferson, Minnesota Vikings
8 Ja’Marr Chase, Cincinnati Bengals
9 Travis Kelce, Kansas City Chiefs
10 Nick Bosa, San Francisco 49ers
`;

const superstarDieCuts = `
1 Patrick Mahomes II, Kansas City Chiefs
2 Joe Burrow, Cincinnati Bengals
3 Lamar Jackson, Baltimore Ravens
4 Brock Purdy, San Francisco 49ers
5 Jordan Love, Green Bay Packers
6 Justin Jefferson, Minnesota Vikings
7 CeeDee Lamb, Dallas Cowboys
8 Ja’Marr Chase, Cincinnati Bengals
9 Travis Kelce, Kansas City Chiefs
10 Nick Bosa, San Francisco 49ers
`;

const touchdownTandems = `
15 Jordan Travis/Malachi Corley, New York Jets/New York Jets /100
`;

const winningTicket = `
1 Patrick Mahomes II, Kansas City Chiefs
2 Brock Purdy, San Francisco 49ers
3 Jalen Hurts, Philadelphia Eagles
4 Dak Prescott, Dallas Cowboys
5 Tua Tagovailoa, Miami Dolphins
6 Trevor Lawrence, Jacksonville Jaguars
7 Josh Allen, Buffalo Bills
8 Jared Goff, Detroit Lions
9 Justin Herbert, Los Angeles Chargers
10 CeeDee Lamb, Dallas Cowboys
11 Justin Jefferson, Minnesota Vikings
12 Ja’Marr Chase, Cincinnati Bengals
13 Amon-Ra St. Brown, Detroit Lions
14 Derrick Henry, Baltimore Ravens
15 Josh Jacobs, Green Bay Packers
16 Deebo Samuel, San Francisco 49ers
17 DK Metcalf, Seattle Seahawks
18 Travis Kelce, Kansas City Chiefs
19 George Kittle, San Francisco 49ers
20 Micah Parsons, Dallas Cowboys
`;

// ---- 2022 Playoff Contenders subset ----
const cantonAutos2022 = `
1 Calvin Johnson, Detroit Lions
2 Earl Campbell, Houston Oilers
`;
const vetAuto2022 = `
1 Derrick Henry, Tennessee Titans
`;

// ---- 2023 Playoff Contenders subset ----
const rookieClearRps2023 = `
1 Aidan O’Connell, Las Vegas Raiders
`;
const rookieConferenceRps2023 = `
1 Cedric Tillman, Cleveland Browns
2 Chase Brown, Cincinnati Bengals
3 Clayton Tune, Arizona Cardinals
4 Deuce Vaughn, Dallas Cowboys
5 Jake Haener, New Orleans Saints
6 Jayden Reed, Green Bay Packers
7 Kendre Miller, New Orleans Saints
8 Roschon Johnson, Chicago Bears
9 Stetson Bennett IV, Los Angeles Rams
10 Tyler Scott, Chicago Bears (NO BASE DIVISIONAL, PLAYOFF, TICKET STUB, OR PLATES)
11 Zach Charbonnet, Seattle Seahawks (CRACKED ICE AND MIDFIELD ONLY)
`;
const rookieVariationRps2023 = `
1 Aidan O’Connell, Las Vegas Raiders
2 Cedric Tillman, Cleveland Browns
3 Chase Brown, Cincinnati Bengals
4 Clayton Tune, Arizona Cardinals
5 Deuce Vaughn, Dallas Cowboys
6 Jake Haener, New Orleans Saints
7 Jayden Reed, Green Bay Packers
8 Kendre Miller, New Orleans Saints
9 Roschon Johnson, Chicago Bears
10 Stetson Bennett IV, Los Angeles Rams (NO BASE)
11 Tyler Scott, Chicago Bears (NO BASE)
12 Zach Charbonnet, Seattle Seahawks (NO BASE)
`;
const rookieRpsRedZone2023 = `
1 Jake Haener, New Orleans Saints
`;
const vetTicket2023 = `
1 Aaron Jones, Green Bay Packers
2 Ahmad “Sauce” Gardner, New York Jets
3 Aidan Hutchinson, Detroit Lions
4 Jalen Tolbert, Dallas Cowboys (NO BASE)
`;

const sets = [
  // Base / Season Ticket family
  set('Base Set', 'base', SEASON_TICKET_PARALLELS, seasonTicket),
  set('RPS Rookie Ticket Autographs', 'autograph', RPS_PARALLELS, rpsRookie),
  set('Rookie Ticket Autographs', 'autograph', ROOKIE_TICKET_PARALLELS, rookieTicket, 123),
  set('Ticket Stub', 'base', [P('Base')], ticketStub, 245),
  set('Rookie Ticket Autographs Opening Kickoff Ticket', 'autograph', [P('Base')], okt),
  set('Rookie Ticket Autographs Playoff Ticket', 'autograph', [P('Base', 149)], playoff149),
  set('RPS Rookie Ticket Autograph Variations', 'autograph', RPS_PARALLELS, rpsVariations),
  set('Rookie Ticket Autograph Variations', 'autograph', ROOKIE_TICKET_PARALLELS, rookieVariations),
  set('Rookie Variations Ticket Stub', 'base', [P('Base')], rookieVariationsStub),

  // Autographs
  set('Contenders Autographs', 'autograph', AUTO_99, contendersAutos),
  set('1999 Contenders Speed Red', 'autograph', [P('Base'), P('Power Blue', 50), P('Finesse Gold', 25), P('Toughness Black', 1)], speedRed),
  set('Legendary Contenders Autographs', 'autograph', AUTO_99, legendaryAutos),
  set('MVP Contenders Autographs', 'autograph', [P('Base', 99), P('Bronze', 25), P('Gold', 10), P('Platinum', 1)], mvpAutos),
  set('NFL Ink Autographs', 'autograph', AUTO_99, nflInk),
  set('Rookie Ticket Swatches Autographs', 'autograph', [P('Base'), P('Variations', 25)], rookieSwatchAutos),
  set('Veteran Ticket Autographs', 'autograph', [P('Base'), P('Opening Kickoff Ticket'), P('Midfield Ticket', 50), P('Cracked Ice Ticket', 23), P('Week 18 Ticket', 18), P('Clear Ticket', 10), P('Super Bowl Ticket', 1), P('Printing Plates', 1)], vetAutos),
  set('Veteran Ticket Autographs Playoff Ticket', 'autograph', [P('Base')], vetAutosPlayoff),
  set('Veteran Ticket Autographs Divisional Ticket', 'autograph', [P('Base')], vetAutosDivisional),
  set('Veteran Ticket Autographs Conference Ticket', 'autograph', [P('Base')], vetAutosConference),
  set('Veteran Ticket Autographs Ticket Stub', 'autograph', [P('Base')], vetAutosStub),
  set('Veteran Ticket FOTL Red Zone Ticket', 'autograph', [P('Base')], vetRedZone),
  set('Veteran Ticket FOTL Goal Line Ticket', 'autograph', [P('Base', 5)], vetGoalLine),

  // Memorabilia
  set('Rookie Ticket Swatches', 'memorabilia', [P('Base'), P('Variations')], rookieSwatches),
  set('Rookie Ticket Dual Swatches', 'memorabilia', [P('Base'), P('Prime', 25)], dualSwatches),

  // Inserts
  set('Contenders to Canton', 'insert', [P('Base', 100), P('Blue', 50), P('Gold', 25), P('Black', 1)], contendersToCanton),
  set('Crown Jewels', 'insert', [P('Base')], crownJewels),
  set('Draft Class Contenders', 'insert', DRAFT_PARALLELS, draftClass),
  set('Gala Tickets', 'insert', [P('Base', 8)], galaTickets),
  set('Hall Pass', 'insert', FOIL_PARALLELS, hallPass),
  set('Historic Draft Class Contenders', 'insert', DRAFT_PARALLELS, historicDraft),
  set('License to Dominate', 'insert', [P('Base')], licenseToDominate),
  set('Permit to Dominate', 'insert', [P('Base')], permitToDominate),
  set('Power Players', 'insert', FOIL_PARALLELS, powerPlayers),
  set('Rookie of the Year Contenders', 'insert', FOIL_PARALLELS, rookieOfYear),
  set('Rookie Stallions', 'insert', DRAFT_PARALLELS, rookieStallions),
  set('Round Numbers', 'insert', DRAFT_PARALLELS, roundNumbers),
  set('Supernatural', 'insert', FOIL_PARALLELS, supernatural),
  set('Superstar Die-Cuts', 'insert', [P('Base')], superstarDieCuts),
  set('Touchdown Tandems', 'insert', [P('Base', 100)], touchdownTandems),
  set('Winning Ticket', 'insert', FOIL_PARALLELS, winningTicket),

  // 2022 Playoff Contenders subset
  set('Contenders to Canton Autographs', 'autograph', [P('Base')], cantonAutos2022),
  set('Veteran Ticket Autograph', 'autograph', [P('Base')], vetAuto2022),

  // 2023 Playoff Contenders subset
  set('Rookie Clear Ticket RPS', 'insert', [P('Base'), P('Variation')], rookieClearRps2023),
  set('Rookie Conference Ticket RPS', 'insert', [P('Base'), P('Midfield Ticket'), P('Playoff Ticket'), P('Divisional Ticket'), P('Cracked Ice Ticket'), P('Super Bowl Ticket'), P('Printing Plates')], rookieConferenceRps2023),
  set('Rookie Variation Ticket RPS', 'insert', [P('Base'), P('Cracked Ice Ticket'), P('Division Ticket'), P('Midfield Ticket'), P('Playoff Ticket'), P('Ticket Stub'), P('Week 18 Ticket'), P('Super Bowl Ticket'), P('Printing Plates')], rookieVariationRps2023),
  set('Rookie Ticket RPS FOTL Red Zone Ticket', 'insert', [P('Base'), P('Goal Line Ticket')], rookieRpsRedZone2023),
  set('Veteran Ticket', 'insert', [P('Base'), P('FOTL Red Zone Ticket'), P('FOTL Goal Line Ticket'), P('Clear Ticket'), P('Conference Ticket'), P('Cracked Ice Ticket'), P('Divisional Ticket'), P('Midfield Ticket'), P('Playoff Ticket'), P('Ticket Stub'), P('Week 18 Ticket'), P('Super Bowl Ticket'), P('Printing Plates')], vetTicket2023),
];

// Guard against accidental duplicate set ids.
const ids = new Set();
for (const s of sets) {
  if (ids.has(s.id)) throw new Error('Duplicate set id: ' + s.id);
  ids.add(s.id);
}

const product = {
  id: '2024-panini-contenders-football',
  name: '2024 Panini Contenders Football',
  year: 2024,
  brand: 'Contenders',
  sport: 'Football',
  sets,
};

fs.writeFileSync(OUT, JSON.stringify(product, null, 0) + '\n');

const totalCards = sets.reduce((n, s) => n + s.totalCards, 0);
console.log(`Wrote ${OUT}`);
console.log(`  sets: ${sets.length}  totalCards(sum of totalCards): ${totalCards}  cards listed: ${sets.reduce((n, s) => n + s.cards.length, 0)}`);

// Update the index.json summary entry to match. The index file is minified
// (single line, no trailing newline) — preserve that format to keep the diff
// limited to this one product's numbers.
const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const entry = index.products.find(p => p.id === product.id);
if (entry) {
  entry.setCount = sets.length;
  entry.totalCards = totalCards;
  fs.writeFileSync(INDEX, JSON.stringify(index));
  console.log(`Updated index.json entry -> setCount ${sets.length}, totalCards ${totalCards}`);
} else {
  console.log('WARNING: no index.json entry found for ' + product.id);
}
