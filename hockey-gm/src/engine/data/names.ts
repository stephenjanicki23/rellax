/** Fictional name pools by nationality. */
export interface NamePool {
  code: string;
  label: string;
  weight: number;
  first: string[];
  last: string[];
  juniorLeagues: string[];
}

const NA_FIRST = [
  'Connor', 'Tyler', 'Ryan', 'Brady', 'Cole', 'Logan', 'Jake', 'Mason', 'Evan', 'Owen', 'Liam', 'Nathan', 'Dylan',
  'Carter', 'Brayden', 'Mitch', 'Jordan', 'Cam', 'Dawson', 'Parker', 'Hunter', 'Travis', 'Wyatt', 'Kyle', 'Jesse',
  'Matt', 'Adam', 'Shane', 'Brett', 'Colton', 'Quinn', 'Jack', 'Luke', 'Noah', 'Ethan', 'Sam', 'Will', 'Ben', 'Max',
  'Zach', 'Trevor', 'Blake', 'Chase', 'Reid', 'Garrett', 'Derek', 'Spencer', 'Tanner', 'Riley', 'Austin', 'Drew',
  'Mark', 'Scott', 'Kevin', 'Jason', 'Bobby', 'Nick', 'Alex', 'Josh', 'Brendan', 'Marcus', 'Devon', 'Jamie', 'Keegan',
  'Brock', 'Gavin', 'Isaac', 'Caleb', 'Seth', 'Rowan', 'Grady', 'Easton', 'Hayden', 'Declan', 'Nolan', 'Gage',
];
const CAN_LAST = [
  'MacDonald', 'Tremblay', 'Gagnon', 'Roy', 'Bouchard', 'Leblanc', 'Gauthier', 'Morin', 'Lavoie', 'Fortin', 'Campbell',
  'McKenzie', 'Fraser', 'Sinclair', 'Doucette', 'Pelletier', 'Bergeron', 'Ouellet', 'Robertson', 'MacLeod', 'Hartley',
  'Brennan', 'Kirkland', 'Whitfield', 'Thibault', 'Desjardins', 'Paquette', 'Lachance', 'Cormier', 'Arsenault',
  'Boucher', 'Dufresne', 'Harlow', 'McAllister', 'Stewart', 'Henderson', 'Cameron', 'Murray', 'Graham', 'Sutherland',
  'Ferguson', 'Gillies', 'Kennedy', 'Lafleur', 'Beaulieu', 'Caron', 'Poirier', 'Cloutier', 'Girard', 'Lambert',
  'Rennick', 'Thornton', 'Carlyle', 'Mercer', 'Dunlop', 'Walsh', 'Gallagher', 'Brodeur', 'Lemaire', 'Savard',
  'Fleury', 'Belanger', 'Hamelin', 'Duchene', 'Marchand', 'Boyle', 'Kerr', 'Ritchie', 'Dowd', 'Pruitt',
];
const USA_LAST = [
  'Johnson', 'Miller', 'Anderson', 'Thompson', 'Walker', 'Mitchell', 'Carlson', 'Peterson', 'Hughes', 'Sullivan',
  'Kelly', 'Brooks', 'Foster', 'Reynolds', 'Hayes', 'Bennett', 'Coleman', 'Porter', 'Fisher', 'Holloway', 'Bishop',
  'Hendricks', 'Callahan', 'Donovan', 'Lawson', 'Maddox', 'Nolan', 'Whitaker', 'Garrison', 'Keller', 'Lindgren',
  'Schmidt', 'Novak', 'Wagner', 'Kowalski', 'Becker', 'Harrington', 'Patterson', 'Russo', 'Fitzgerald', 'Quinlan',
  'Barrett', 'Shaw', 'Dalton', 'Vaughn', 'Mercer', 'Rowe', 'Tate', 'Hale', 'Pierce', 'Sawyer', 'Gibbons', 'Kane',
  'Larkin', 'McCarthy', 'Doyle', 'Brennan', 'Sheridan', 'Townsend', 'Ward', 'Ellis', 'Cooper', 'Graves', 'Stone',
];
const SWE_FIRST = ['Erik', 'Lars', 'Oskar', 'Viktor', 'Gustav', 'Anton', 'Elias', 'Filip', 'Johan', 'Henrik', 'Nils', 'Axel', 'Emil', 'Linus', 'Rasmus', 'Hampus', 'Jonas', 'Mattias', 'Albin', 'Isak', 'Melker', 'William', 'Lucas', 'Adrian'];
const SWE_LAST = ['Lindqvist', 'Andersson', 'Karlsson', 'Nilsson', 'Eriksson', 'Larsson', 'Olsson', 'Persson', 'Svensson', 'Gustafsson', 'Johansson', 'Holmberg', 'Sandström', 'Bergqvist', 'Nyberg', 'Lundgren', 'Ekholm', 'Hedman', 'Sjöberg', 'Forsberg', 'Wennberg', 'Dahlin', 'Lindholm', 'Åberg', 'Hägg', 'Strand', 'Brännström'];
const FIN_FIRST = ['Mikko', 'Teemu', 'Jari', 'Aleksi', 'Sami', 'Juho', 'Eetu', 'Kasperi', 'Roope', 'Ville', 'Lauri', 'Patrik', 'Joonas', 'Otto', 'Aatu', 'Kaapo', 'Niko', 'Jesse', 'Arttu', 'Henri'];
const FIN_LAST = ['Koivu', 'Laine', 'Rantanen', 'Virtanen', 'Mäkinen', 'Heiskanen', 'Korhonen', 'Nieminen', 'Lehtonen', 'Salo', 'Hakala', 'Kotkaniemi', 'Puljujärvi', 'Aho', 'Granlund', 'Hintz', 'Kapanen', 'Lindell', 'Raty', 'Saarinen', 'Tolvanen', 'Vesalainen'];
const RUS_FIRST = ['Alexei', 'Dmitri', 'Nikita', 'Ivan', 'Sergei', 'Artem', 'Pavel', 'Kirill', 'Andrei', 'Mikhail', 'Yegor', 'Vladislav', 'Maxim', 'Denis', 'Ilya', 'Roman', 'Evgeni', 'Vasili'];
const RUS_LAST = ['Volkov', 'Petrov', 'Ivanov', 'Sokolov', 'Kuznetsov', 'Morozov', 'Orlov', 'Zaitsev', 'Fedorov', 'Belov', 'Kozlov', 'Romanov', 'Antipov', 'Gusev', 'Panarin', 'Shestyorkin', 'Tarasenko', 'Kaprizov', 'Zadorov', 'Grigorenko', 'Malkin', 'Nesterov'];
const CZE_FIRST = ['Jakub', 'Tomas', 'Ondrej', 'David', 'Martin', 'Lukas', 'Filip', 'Radek', 'Jiri', 'Michal', 'Pavel', 'Vojtech', 'Matej', 'Dominik'];
const CZE_LAST = ['Novak', 'Svoboda', 'Dvorak', 'Cerny', 'Prochazka', 'Kucera', 'Vesely', 'Hasek', 'Pastrnak', 'Necas', 'Hertl', 'Voracek', 'Kubalik', 'Zacha', 'Hronek', 'Jagr', 'Palat', 'Simek', 'Rutta'];
const SVK_FIRST = ['Marian', 'Tomas', 'Juraj', 'Martin', 'Erik', 'Simon', 'Adam', 'Peter', 'Richard', 'Dalibor'];
const SVK_LAST = ['Hossa', 'Chara', 'Tatar', 'Slafkovsky', 'Nemec', 'Cernak', 'Halak', 'Gaborik', 'Visnovsky', 'Fehervary', 'Pospisil', 'Regenda'];
const GER_FIRST = ['Leon', 'Moritz', 'Tim', 'Dominik', 'Tobias', 'Lukas', 'Jonas', 'Felix', 'Nico', 'Maximilian', 'Philipp', 'Marco'];
const GER_LAST = ['Draisaitl', 'Seider', 'Stützle', 'Grubauer', 'Kahun', 'Holzer', 'Müller', 'Schneider', 'Fischer', 'Weber', 'Wagner', 'Reichel', 'Peterka', 'Sturm'];
const SUI_FIRST = ['Roman', 'Nico', 'Kevin', 'Timo', 'Nino', 'Janis', 'Pius', 'Denis', 'Gaetan', 'Luca'];
const SUI_LAST = ['Josi', 'Hischier', 'Fiala', 'Meier', 'Niederreiter', 'Siegenthaler', 'Moser', 'Suter', 'Malgin', 'Bertschy', 'Genoni', 'Kurashev'];
const LAT_FIRST = ['Zemgus', 'Kristians', 'Rudolfs', 'Elvis', 'Teodors', 'Arturs', 'Kaspars'];
const LAT_LAST = ['Girgensons', 'Balcers', 'Merzlikins', 'Blugers', 'Rubins', 'Silovs', 'Abols', 'Daugavins', 'Kenins'];

export const NAME_POOLS: NamePool[] = [
  { code: 'CAN', label: 'Canada', weight: 40, first: NA_FIRST, last: CAN_LAST, juniorLeagues: ['OHL', 'WHL', 'QMJHL'] },
  { code: 'USA', label: 'United States', weight: 27, first: NA_FIRST, last: USA_LAST, juniorLeagues: ['USHL', 'NCAA', 'USNTDP'] },
  { code: 'SWE', label: 'Sweden', weight: 9, first: SWE_FIRST, last: SWE_LAST, juniorLeagues: ['SHL', 'J20 Nationell', 'Allsvenskan'] },
  { code: 'FIN', label: 'Finland', weight: 6, first: FIN_FIRST, last: FIN_LAST, juniorLeagues: ['Liiga', 'U20 SM-sarja', 'Mestis'] },
  { code: 'RUS', label: 'Russia', weight: 6, first: RUS_FIRST, last: RUS_LAST, juniorLeagues: ['KHL', 'MHL', 'VHL'] },
  { code: 'CZE', label: 'Czechia', weight: 4, first: CZE_FIRST, last: CZE_LAST, juniorLeagues: ['Extraliga', 'Czech U20'] },
  { code: 'SVK', label: 'Slovakia', weight: 2, first: SVK_FIRST, last: SVK_LAST, juniorLeagues: ['Slovak Extraliga'] },
  { code: 'GER', label: 'Germany', weight: 2, first: GER_FIRST, last: GER_LAST, juniorLeagues: ['DEL', 'DNL'] },
  { code: 'SUI', label: 'Switzerland', weight: 2, first: SUI_FIRST, last: SUI_LAST, juniorLeagues: ['National League', 'U20-Elit'] },
  { code: 'LAT', label: 'Latvia', weight: 1, first: LAT_FIRST, last: LAT_LAST, juniorLeagues: ['OHL', 'Latvian HL'] },
];

export const COACH_FIRST = [
  'Mike', 'Bruce', 'Paul', 'Peter', 'Dave', 'Rick', 'Jon', 'Gerard', 'Claude', 'Todd', 'Barry', 'Darryl', 'Joel',
  'Lindy', 'Ken', 'Glen', 'Randy', 'Andre', 'Jim', 'Dan', 'Ron', 'Bob', 'Craig', 'Rod', 'Jeff', 'Doug', 'Marc',
];

export const GM_FIRST = ['Steve', 'Brian', 'Kyle', 'Chris', 'Don', 'Pierre', 'Doug', 'Ray', 'Jim', 'Lou', 'Ron', 'Kevin', 'Tom', 'Bill'];

export const OWNER_NAMES = [
  'Harlan Group', 'Bellweather Holdings', 'The Kessler Family', 'Northstar Capital', 'Redline Sports & Ent.',
  'Marlowe Investments', 'Crestview Partners', 'The Aldridge Trust', 'Summit Sports Group', 'Pemberton Holdings',
];

const EXTRA_COUNTRIES: Record<string, string> = {
  DNK: 'Denmark', NOR: 'Norway', AUT: 'Austria', FRA: 'France', BLR: 'Belarus', SVN: 'Slovenia', KAZ: 'Kazakhstan',
  GBR: 'Great Britain', AUS: 'Australia', UKR: 'Ukraine', NLD: 'Netherlands', POL: 'Poland', ITA: 'Italy', JPN: 'Japan',
  KOR: 'South Korea', HUN: 'Hungary', LTU: 'Lithuania', EST: 'Estonia', BRA: 'Brazil', JAM: 'Jamaica', NGA: 'Nigeria',
  ZAF: 'South Africa', VEN: 'Venezuela', TWN: 'Taiwan', CHN: 'China', BHS: 'Bahamas', MEX: 'Mexico', CRO: 'Croatia',
};

/** Display name for a nationality code (name-pool codes plus ISO-3 codes from real rosters). */
export function countryLabel(code: string): string {
  return NAME_POOLS.find((n) => n.code === code)?.label ?? EXTRA_COUNTRIES[code] ?? code;
}
