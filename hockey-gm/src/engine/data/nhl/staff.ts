import type { CoachPhilosophy, CoachRatings, Tactics } from '../../types';
/**
 * Real NHL front offices. Head coaches come from the roster snapshot (read
 * from the NHL feed by `npm run fetch:nhl -- --staff-only`). General managers
 * are not in the feed, so they live here (as of October 2026).
 */
export const NHL_GMS: Record<string, string> = {
  ANA: 'Pat Verbeek', BOS: 'Don Sweeney', BUF: 'Jarmo Kekalainen', CGY: 'Craig Conroy', CAR: 'Eric Tulsky',
  CHI: 'Kyle Davidson', COL: 'Joe Sakic', CBJ: 'Don Waddell', DAL: 'Jim Nill', DET: 'Shawn Horcoff',
  EDM: 'Stan Bowman', FLA: 'Bill Zito', LAK: 'Ken Holland', MIN: 'Bill Guerin', MTL: 'Kent Hughes',
  NSH: 'Chris MacFarland', NJD: 'Sunny Mehta', NYI: 'Mathieu Darche', NYR: 'Chris Drury', OTT: 'Steve Staios',
  PHI: 'Daniel Briere', PIT: 'Kyle Dubas', SJS: 'Mike Grier', SEA: 'Jason Botterill', STL: 'Alexander Steen',
  TBL: 'Julien BriseBois', TOR: 'John Chayka', UTA: 'Bill Armstrong', VAN: 'Ryan Johnson', VGK: 'Kelly McCrimmon',
  WSH: 'Chris Patrick', WPG: 'Kevin Cheveldayoff',
};

/**
 * Coach quality (same scale as generated coaches, ~60–170) for head coaches
 * with a proven record: Stanley Cups, Jack Adams awards, long winning runs.
 * Anyone not listed gets a typical generated rating.
 */
export const COACH_QUALITY: Record<string, number> = {
  'Jon Cooper': 158, 'Paul Maurice': 152, 'Mike Sullivan': 150, 'Jared Bednar': 150, 'Joel Quenneville': 148,
  "Rod Brind'Amour": 152, 'Mike Babcock': 140, 'Peter DeBoer': 140, 'Peter Laviolette': 138, 'Rick Tocchet': 138,
  'Spencer Carbery': 136, 'Jim Montgomery': 134, 'Sheldon Keefe': 130, 'Lindy Ruff': 128, 'Rick Bowness': 126,
  'Martin St. Louis': 124, 'John Hynes': 124, 'André Tourigny': 122, 'Todd McLellan': 124, 'Glen Gulutzan': 122,
};

/**
 * Coaching identities for current NHL head coaches: philosophy, signature
 * system (preferred tactics) and rating leanings. These are editorial
 * profiles of each coach's reputation and typical team identity (not
 * official data); anyone missing falls back to a generated profile.
 */
export interface CoachProfile {
  philosophy: CoachPhilosophy;
  system?: Partial<Tactics>;
  lean?: Partial<Record<keyof CoachRatings, number>>;
  note: string;
}

export const COACH_PROFILES: Record<string, CoachProfile> = {
  'Jon Cooper': { philosophy: 'structured', system: { offense: 'possession', defense: 'balanced', pp: 'umbrella' }, lean: { tactics: 16, motivation: 8 }, note: 'Adaptable, structured system built on puck management' },
  'Paul Maurice': { philosophy: 'physical', system: { offense: 'dumpChase', defense: 'aggressive', forecheck: '2-1-2' }, lean: { motivation: 14, defense: 6 }, note: 'Relentless heavy forecheck and physical identity' },
  "Rod Brind'Amour": { philosophy: 'structured', system: { offense: 'cycle', defense: 'aggressive', forecheck: '2-1-2', pp: 'shooting', pk: 'aggressive' }, lean: { motivation: 12, defense: 10 }, note: 'Aggressive man-to-man pressure and shot volume' },
  'Mike Sullivan': { philosophy: 'offensive', system: { offense: 'rush', defense: 'aggressive' }, lean: { offense: 10, motivation: 6 }, note: 'Fast, attacking transition game' },
  'Jared Bednar': { philosophy: 'offensive', system: { offense: 'rush', defense: 'aggressive', pp: 'overload' }, lean: { offense: 12 }, note: 'Speed and skill off the rush' },
  'Joel Quenneville': { philosophy: 'offensive', system: { offense: 'possession', pp: 'overload' }, lean: { offense: 10, tactics: 6 }, note: 'Puck-possession offence with mobile defencemen' },
  'Peter DeBoer': { philosophy: 'defensive', system: { offense: 'cycle', defense: 'passive', forecheck: '1-2-2' }, lean: { defense: 10, tactics: 6 }, note: 'Structured, low-event team defence' },
  'Peter Laviolette': { philosophy: 'physical', system: { offense: 'dumpChase', defense: 'aggressive', forecheck: '2-1-2' }, lean: { motivation: 10 }, note: 'Aggressive forecheck and up-tempo pressure' },
  'Rick Tocchet': { philosophy: 'physical', system: { offense: 'cycle', defense: 'physical' }, lean: { motivation: 12, defense: 6 }, note: 'Hard, accountable, heavy hockey' },
  'Spencer Carbery': { philosophy: 'structured', system: { offense: 'possession', defense: 'balanced', pp: 'umbrella' }, lean: { tactics: 12 }, note: 'Analytical, detail-driven structure' },
  'Jim Montgomery': { philosophy: 'structured', system: { offense: 'rush', defense: 'aggressive', forecheck: '2-1-2' }, lean: { tactics: 10, offense: 6 }, note: 'Up-tempo pressure with a modern structure' },
  'Sheldon Keefe': { philosophy: 'offensive', system: { offense: 'possession', pp: 'overload' }, lean: { offense: 10 }, note: 'Skill and puck possession' },
  'Lindy Ruff': { philosophy: 'defensive', system: { offense: 'balanced', defense: 'trap', forecheck: '1-3-1' }, lean: { defense: 8, motivation: 6 }, note: 'Veteran, defence-first structure' },
  'Todd McLellan': { philosophy: 'balanced', system: { pp: 'overload' }, lean: { offense: 6 }, note: 'Balanced system with a strong power play' },
  'Martin St. Louis': { philosophy: 'development', system: { offense: 'possession', defense: 'aggressive', pp: 'overload' }, lean: { development: 14, offense: 6 }, note: 'Teaching coach; creativity and puck support' },
  'Travis Green': { philosophy: 'physical', system: { offense: 'cycle', defense: 'physical' }, lean: { defense: 6, motivation: 6 }, note: 'Heavy, hard-to-play-against identity' },
  'Marco Sturm': { philosophy: 'structured', system: { offense: 'dumpChase', defense: 'physical' }, lean: { tactics: 6, development: 6 }, note: 'Structured, hard-working forecheck' },
  'Jim Hiller': { philosophy: 'balanced', system: { pp: 'shooting' }, lean: { offense: 4 }, note: 'Power-play specialist running a balanced system' },
  'Rick Bowness': { philosophy: 'defensive', system: { offense: 'cycle', defense: 'trap', forecheck: '1-3-1' }, lean: { defense: 12 }, note: 'Defensive structure and accountability' },
  'Dan Muse': { philosophy: 'development', system: { offense: 'rush', defense: 'aggressive' }, lean: { development: 14 }, note: 'Player development from USA Hockey' },
  'Jeff Blashill': { philosophy: 'development', system: { offense: 'balanced', defense: 'balanced' }, lean: { development: 12 }, note: 'Development-focused with young core' },
  'Glen Gulutzan': { philosophy: 'offensive', system: { offense: 'rush', pp: 'overload' }, lean: { offense: 12 }, note: 'Offence and power-play architect' },
  'John Hynes': { philosophy: 'defensive', system: { offense: 'dumpChase', defense: 'passive', pk: 'box' }, lean: { defense: 10, motivation: 6 }, note: 'Hard-working, defence-first structure' },
  'Andrew Brunette': { philosophy: 'offensive', system: { offense: 'possession', pp: 'netFront' }, lean: { offense: 10 }, note: 'Offensive creativity and net-front play' },
  'André Tourigny': { philosophy: 'development', system: { offense: 'rush', defense: 'aggressive' }, lean: { development: 12, motivation: 6 }, note: 'Teacher building around young skill' },
  'Scott Arniel': { philosophy: 'defensive', system: { offense: 'balanced', defense: 'passive', pk: 'box' }, lean: { defense: 10 }, note: 'Defensive structure in front of an elite goalie' },
  'Ryan Huska': { philosophy: 'defensive', system: { offense: 'dumpChase', defense: 'physical' }, lean: { defense: 8, motivation: 6 }, note: 'Hard-working, structured defence' },
  'Mike Babcock': { philosophy: 'structured', system: { offense: 'cycle', defense: 'balanced', forecheck: '1-2-2' }, lean: { tactics: 12, defense: 6 }, note: 'Demanding, highly structured system' },
  'Ryan Warsofsky': { philosophy: 'development', system: { offense: 'rush', defense: 'aggressive' }, lean: { development: 12 }, note: 'Young coach developing a young roster' },
  'Lane Lambert': { philosophy: 'defensive', system: { offense: 'dumpChase', defense: 'trap', forecheck: '1-3-1' }, lean: { defense: 12 }, note: 'Defensive structure from the Trotz tree' },
  'Manny Malhotra': { philosophy: 'structured', system: { offense: 'cycle', defense: 'passive', pk: 'box' }, lean: { defense: 8, development: 6 }, note: 'Detail and faceoff-driven structure' },
  'Ryan Craig': { philosophy: 'balanced', system: { defense: 'aggressive' }, lean: { motivation: 6 }, note: 'Balanced, pressure-based system' },
};

/** Split "Rod Brind'Amour" / "Martin St. Louis" into first and last name. */
export function splitName(full: string): { first: string; last: string } {
  const i = full.indexOf(' ');
  return i < 0 ? { first: '', last: full } : { first: full.slice(0, i), last: full.slice(i + 1) };
}
