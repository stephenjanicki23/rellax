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

/** Split "Rod Brind'Amour" / "Martin St. Louis" into first and last name. */
export function splitName(full: string): { first: string; last: string } {
  const i = full.indexOf(' ');
  return i < 0 ? { first: '', last: full } : { first: full.slice(0, i), last: full.slice(i + 1) };
}
