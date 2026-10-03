import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_CONFIG } from '../../engine/data/leagueConfig';
import type { League, Player } from '../../engine/types';
import type { SaveMeta } from '../../engine/save';
import { newGame, loadGame, importGame, toast, ask } from '../store';
import { listSaves, deleteSave } from '../db';
import { TeamLogo } from '../components/common';
import { LiveView } from '../pages/LiveGame';
import { PHASE_LABEL, seasonLabel } from '../format';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { isForward } from '../../engine/player/ability';
import { playersOf } from '../../engine/league/helpers';
import { Jersey, Emblem } from './Jersey';
import { PlayerCardView, potentialGrade } from './PlayerCard';
import { EXHIBITION_SEED, exhibitionInput, exhibitionLeague, heroNumber, playerOvr, teamRatings } from './exhibition';
import './menu.css';

type Screen = 'title' | 'playnow' | 'live' | 'franchiseNew' | 'franchiseLoad' | 'rosters';
const TEAMS = DEFAULT_CONFIG.teams;
const N = TEAMS.length;
const wrap = (i: number) => ((i % N) + N) % N;

function useKeys(handler: (e: KeyboardEvent) => void, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const f = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      ref.current(e);
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [active]);
}

/** Lazily build the shared exhibition league without blocking the first paint. */
function useExhibition(needed: boolean): League | null {
  const [league, setLeague] = useState<League | null>(null);
  useEffect(() => {
    if (!needed || league) return;
    const t = setTimeout(() => setLeague(exhibitionLeague()), 30);
    return () => clearTimeout(t);
  }, [needed, league]);
  return league;
}

export function MainMenu() {
  const [screen, setScreen] = useState<Screen>('title');
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [heroTeam, setHeroTeam] = useState(() => Math.floor(Math.random() * N));
  const [fade, setFade] = useState(false);
  const [match, setMatch] = useState<{ home: number; away: number; seed: number }>({ home: 0, away: 1, seed: 1 });
  const refreshSaves = useCallback(() => void listSaves().then(setSaves).catch(() => setSaves([])), []);
  useEffect(refreshSaves, [refreshSaves]);
  const league = useExhibition(screen === 'playnow' || screen === 'rosters' || screen === 'live');

  // Attract mode: the hero jersey cycles through teams on the title screen.
  useEffect(() => {
    if (screen !== 'title') return;
    const id = setInterval(() => {
      setFade(true);
      setTimeout(() => {
        setHeroTeam((t) => wrap(t + 1 + Math.floor(Math.random() * 5)));
        setFade(false);
      }, 600);
    }, 7000);
    return () => clearInterval(id);
  }, [screen]);

  const shownTeam = screen === 'playnow' ? match.home : heroTeam;
  const t = TEAMS[shownTeam];
  const style = { '--m-team': t.colors[0], '--m-team2': t.colors[1] } as CSSProperties;
  const showHero = screen === 'title';

  return (
    <div className="mm" style={style}>
      <div className="mm-bg" />
      <div className="mm-panel" />
      <div className="mm-slash" />
      <div className="mm-slash two" />
      {showHero && (
        <div className={`mm-hero ${fade ? 'fade' : ''}`}>
          <Jersey primary={t.colors[0]} secondary={t.colors[1]} number={heroNumber(shownTeam)} abbr={t.abbr} />
        </div>
      )}
      {screen === 'title' && <Title saves={saves} go={setScreen} />}
      {screen === 'playnow' &&
        (league ? (
          <PlayNow
            match={match}
            setMatch={setMatch}
            onBack={() => setScreen('title')}
            onPlay={() => {
              setMatch((m) => ({ ...m, seed: Math.floor(Math.random() * 1e9) }));
              setScreen('live');
            }}
          />
        ) : (
          <div className="mm-loading">Loading rosters…</div>
        ))}
      {screen === 'live' && league && <Exhibition match={match} setMatch={setMatch} onTeams={() => setScreen('playnow')} onMenu={() => setScreen('title')} />}
      {screen === 'franchiseNew' && <FranchiseNew onBack={() => setScreen('title')} />}
      {screen === 'franchiseLoad' && <FranchiseLoad saves={saves} refresh={refreshSaves} onBack={() => setScreen('title')} />}
      {screen === 'rosters' && (league ? <Rosters league={league} onBack={() => setScreen('title')} /> : <div className="mm-loading">Loading rosters…</div>)}
      <Footer emblem={screen === 'title'} />
    </div>
  );
}

// ───────────────────────────── title ─────────────────────────────

interface Entry {
  id: string;
  label: string;
  hint?: string;
  tag?: string;
  sub?: { label: string; disabled?: boolean; run: () => void }[];
  run?: () => void;
}

function Title({ saves, go }: { saves: SaveMeta[]; go: (s: Screen) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = saves[0];
  const entries: Entry[] = [
    { id: 'play', label: 'Play Now', hint: 'Exhibition game. Pick any two teams and drop the puck — nothing is saved.', run: () => go('playnow') },
    {
      id: 'franchise',
      label: 'Franchise',
      tag: saves.length ? `${saves.length} SAVE${saves.length > 1 ? 'S' : ''}` : undefined,
      sub: [
        ...(latest
          ? [{ label: `Continue · ${latest.teamName.split(' ').slice(-1)[0]} ${seasonLabel(latest.season)}`, run: () => void loadGame(latest.id).catch((e) => toast(String(e), 'bad')) }]
          : []),
        { label: 'New Franchise', run: () => go('franchiseNew') },
        { label: 'Load Franchise', disabled: !saves.length, run: () => go('franchiseLoad') },
        { label: 'Import Save File', run: () => fileRef.current?.click() },
      ],
    },
    { id: 'rosters', label: 'Rosters', hint: "Browse every team's lineup and ratings.", run: () => go('rosters') },
  ];
  const [sel, setSel] = useState(0);
  const [sub, setSub] = useState<number | null>(null);
  const cur = entries[sel];
  const subItems = cur.sub ?? [];
  const activate = () => {
    if (sub !== null) {
      const it = subItems[sub];
      if (it && !it.disabled) it.run();
      return;
    }
    if (cur.sub) setSub(subItems.findIndex((s) => !s.disabled));
    else cur.run?.();
  };
  const moveSub = (d: number) => {
    let i = sub ?? 0;
    for (let k = 0; k < subItems.length; k++) {
      i = (i + d + subItems.length) % subItems.length;
      if (!subItems[i].disabled) break;
    }
    setSub(i);
  };
  useKeys((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (sub !== null) moveSub(1);
      else setSel((s) => (s + 1) % entries.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (sub !== null) moveSub(-1);
      else setSel((s) => (s - 1 + entries.length) % entries.length);
    } else if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && cur.sub && sub === null)) {
      e.preventDefault();
      activate();
    } else if ((e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'Backspace') && sub !== null) {
      e.preventDefault();
      setSub(null);
    }
  });

  return (
    <>
      <div className="mm-head">
        <div className="mm-word">
          Hockey GM
          <small>{DEFAULT_CONFIG.name}</small>
        </div>
      </div>
      <nav className="mm-menu" aria-label="Main menu">
        {entries.map((e, i) => (
          <div key={e.id} style={{ position: 'relative' }}>
            <button
              className={`mm-item ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => {
                if (i !== sel) {
                  setSel(i);
                  setSub(null);
                }
              }}
              onClick={() => {
                setSel(i);
                if (e.sub) setSub(e.sub.findIndex((s) => !s.disabled));
                else e.run?.();
              }}
            >
              {i === 0 && <span className="mm-ring" aria-hidden="true" />}
              {e.label}
              {e.tag && <span className="tag">{e.tag}</span>}
            </button>
            {i === sel && (
              <div className="mm-sub">
                {e.sub
                  ? e.sub.map((s, j) => (
                      <button
                        key={s.label}
                        className={`mm-subitem ${sub === j ? 'sel' : ''}`}
                        disabled={s.disabled}
                        onMouseEnter={() => !s.disabled && setSub(j)}
                        onClick={() => !s.disabled && s.run()}
                      >
                        {s.label}
                      </button>
                    ))
                  : e.hint && <div className="mm-hint">{e.hint}</div>}
              </div>
            )}
          </div>
        ))}
      </nav>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={async (ev) => {
          const f = ev.target.files?.[0];
          if (!f) return;
          try {
            importGame(await f.text());
          } catch (err) {
            toast((err as Error).message, 'bad');
          }
        }}
      />
    </>
  );
}

// ───────────────────────────── shell pieces ─────────────────────────────

function Footer({ emblem }: { emblem: boolean }) {
  const items = useMemo(() => {
    const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
    const a = pick(TEAMS);
    const b = pick(TEAMS.filter((x) => x !== a));
    const c = pick(TEAMS.filter((x) => x !== a && x !== b));
    const div = DEFAULT_CONFIG.divisions.find((d) => d.id === b.divisionId)!;
    return [
      ['Preseason', `${a.city} ${a.name} open training camp at ${a.arena}`],
      ['Stanley Cup', `Early odds make the ${b.city} ${b.name} favourites in the ${div.name} Division`],
      ['Tip', 'Play Now drops you straight into an exhibition game — no save required'],
      ['Scouting', "In Franchise mode you only see estimates of other teams' players until your scouts get a good look"],
      ['Rumor', `${c.city} reportedly shopping a veteran defenseman before opening night`],
      ['Rosters', `${N} teams, every player rated from 1 to 99`],
    ];
  }, []);
  return (
    <>
      <footer className="mm-foot">
        <span className="label">{DEFAULT_CONFIG.shortName} Network</span>
        <div className="mm-ticker" aria-live="off">
          <div className="mm-ticker-track">
            {[0, 1].map((copy) => (
              <span key={copy} aria-hidden={copy === 1}>
                {items.map(([k, v]) => (
                  <span key={k}>
                    <b>{k}</b>
                    {v}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
        <span className="mm-keys">
          <kbd>↑↓</kbd>Select<kbd>Enter</kbd>Confirm<kbd>Esc</kbd>Back
        </span>
      </footer>
      {emblem && (
        <div className="mm-foot-emblem">
          <Emblem size={84} />
        </div>
      )}
    </>
  );
}

function ScreenHead({ title, sub, onBack, right }: { title: ReactNode; sub?: string; onBack: () => void; right?: ReactNode }) {
  useKeys((e) => {
    if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      onBack();
    }
  });
  return (
    <div className="mm-title">
      <button className="mm-back" onClick={onBack}>
        ◀ Back
      </button>
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {right && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{right}</div>}
    </div>
  );
}

// ───────────────────────────── play now ─────────────────────────────

function TeamPicker({ label, team, focus, onFocus, onChange }: { label: string; team: number; focus: boolean; onFocus: () => void; onChange: (d: number) => void }) {
  const t = TEAMS[team];
  const r = teamRatings(team);
  const rows: [string, number][] = [
    ['Overall', r.ovr],
    ['Offense', r.off],
    ['Defense', r.def],
    ['Goalie', r.g],
  ];
  return (
    <div className={`mm-pick ${focus ? 'focus' : ''}`} onMouseDown={onFocus}>
      <span className="side">{label}</span>
      <div className="mm-box" style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div className="cyc">
          <button className="mm-arrow" aria-label={`Previous ${label.toLowerCase()} team`} onClick={() => onChange(-1)}>
            ◀
          </button>
          <div className="mm-pick-jersey">
            <Jersey primary={t.colors[0]} secondary={t.colors[1]} number={heroNumber(team)} abbr={t.abbr} />
          </div>
          <button className="mm-arrow" aria-label={`Next ${label.toLowerCase()} team`} onClick={() => onChange(1)}>
            ▶
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <TeamLogo team={t} size={40} />
          <div style={{ textAlign: 'left' }}>
            <div className="city">{t.city}</div>
            <div className="name">{t.name}</div>
          </div>
        </div>
        <div className="mm-ratings">
          {rows.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span>{k}</span>
              <span className="bar">
                <i style={{ width: `${v}%` }} />
              </span>
              <b>{v}</b>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayNow({ match, setMatch, onBack, onPlay }: { match: { home: number; away: number; seed: number }; setMatch: (f: (m: { home: number; away: number; seed: number }) => { home: number; away: number; seed: number }) => void; onBack: () => void; onPlay: () => void }) {
  const [focus, setFocus] = useState<'away' | 'home'>('home');
  const change = (side: 'away' | 'home', d: number) =>
    setMatch((m) => {
      let v = wrap(m[side] + d);
      const other = side === 'home' ? m.away : m.home;
      if (v === other) v = wrap(v + d);
      return { ...m, [side]: v };
    });
  const random = () =>
    setMatch((m) => {
      const h = Math.floor(Math.random() * N);
      let a = Math.floor(Math.random() * N);
      if (a === h) a = wrap(a + 1);
      return { ...m, home: h, away: a };
    });
  useKeys((e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      change(focus, -1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      change(focus, 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      setFocus((f) => (f === 'home' ? 'away' : 'home'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPlay();
    }
  });
  return (
    <div className="mm-screen">
      <ScreenHead title="Play Now" sub="Choose the matchup. ← → change team · ↑↓ switch side · Enter to play" onBack={onBack} />
      <div className="mm-vs">
        <TeamPicker label="AWAY" team={match.away} focus={focus === 'away'} onFocus={() => setFocus('away')} onChange={(d) => change('away', d)} />
        <div className="vs">VS</div>
        <TeamPicker label="HOME" team={match.home} focus={focus === 'home'} onFocus={() => setFocus('home')} onChange={(d) => change('home', d)} />
      </div>
      <div className="mm-actions">
        <button className="mm-back mm-btn-hi" onClick={onPlay}>
          Drop the puck ▶
        </button>
        <button className="mm-back" onClick={random}>
          Random matchup
        </button>
      </div>
    </div>
  );
}

function Exhibition({ match, setMatch, onTeams, onMenu }: { match: { home: number; away: number; seed: number }; setMatch: (f: (m: { home: number; away: number; seed: number }) => { home: number; away: number; seed: number }) => void; onTeams: () => void; onMenu: () => void }) {
  const league = exhibitionLeague();
  const input = useMemo(() => exhibitionInput(match.home, match.away, match.seed), [match]);
  const home = league.teams[match.home];
  const away = league.teams[match.away];
  return (
    <div className="mm-live">
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="mm-back" onClick={onMenu}>
          ◀ Main menu
        </button>
        <button className="mm-back" onClick={onTeams}>
          Change teams
        </button>
        <span style={{ color: 'var(--m-dim)', fontFamily: 'var(--m-display)', fontSize: 16, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Exhibition · not saved</span>
      </div>
      <LiveView
        key={`${match.home}-${match.away}-${match.seed}`}
        input={input}
        home={home}
        away={away}
        playoff={false}
        info={`Exhibition · ${home.arena}`}
        finishLabel="Rematch ↻"
        onFinish={() => setMatch((m) => ({ ...m, seed: m.seed + 1 }))}
      />
    </div>
  );
}

// ───────────────────────────── franchise ─────────────────────────────

function FranchiseNew({ onBack }: { onBack: () => void }) {
  const [team, setTeam] = useState(0);
  const [seed, setSeed] = useState(EXHIBITION_SEED);
  const start = () => newGame({ seed: seed.trim() || EXHIBITION_SEED, userTeamId: team });
  return (
    <div className="mm-screen">
      <ScreenHead
        title="New Franchise"
        sub="Pick the club you'll run. You control everything: lines, tactics, trades, the draft and the cap."
        onBack={onBack}
        right={
          <button className="mm-back mm-btn-hi" onClick={start}>
            Start with {TEAMS[team].name} ▶
          </button>
        }
      />
      {DEFAULT_CONFIG.divisions.map((d) => (
        <div key={d.id}>
          <div className="mm-div">{d.name} Division</div>
          <div className="mm-grid">
            {TEAMS.map((t, i) => ({ t, i }))
              .filter(({ t }) => t.divisionId === d.id)
              .map(({ t, i }) => (
                <button key={t.abbr} className={`mm-team ${team === i ? 'sel' : ''}`} onClick={() => setTeam(i)} onDoubleClick={start}>
                  <TeamLogo team={t} size={34} />
                  <span style={{ opacity: 1 }}>
                    <b>{t.city}</b>
                    <span>
                      {t.name} · Market {'●'.repeat(t.marketSize)}
                      {'○'.repeat(5 - t.marketSize)}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}
      <div className="mm-box" style={{ marginTop: 18, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="mm-field">
          League seed
          <input id="franchise-seed" type="text" value={seed} onChange={(e) => setSeed(e.target.value)} />
        </label>
        <button className="mm-back" onClick={() => setSeed(`nhl-${Math.floor(Math.random() * 1e9).toString(36)}`)}>
          New random league
        </button>
        <button className="mm-back" onClick={() => setSeed(EXHIBITION_SEED)}>
          Default rosters
        </button>
        <p style={{ margin: 0, color: 'var(--m-dim)', font: '500 15px/1.35 var(--m-display)', maxWidth: 460, letterSpacing: '0.02em' }}>
          The default seed uses the same league you see in Rosters and Play Now. A new seed generates a different universe of players. Every game is reproducible from its seed.
        </p>
      </div>
    </div>
  );
}

function FranchiseLoad({ saves, refresh, onBack }: { saves: SaveMeta[]; refresh: () => void; onBack: () => void }) {
  return (
    <div className="mm-screen">
      <ScreenHead title="Load Franchise" sub="Saved in this browser." onBack={onBack} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 820 }}>
        {saves.map((s) => (
          <div key={s.id} className="mm-team" style={{ cursor: 'default' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>{s.teamName}</b>
              <span>
                {seasonLabel(s.season)} · {PHASE_LABEL[s.phase as keyof typeof PHASE_LABEL] ?? s.phase} · saved {new Date(s.savedAt).toLocaleString()}
              </span>
            </span>
            <button className="mm-back mm-btn-hi" onClick={() => void loadGame(s.id).catch((e) => toast(String(e), 'bad'))}>
              Load
            </button>
            <button
              className="mm-back"
              onClick={async () => {
                if (await ask(`Delete the save "${s.teamName} ${seasonLabel(s.season)}"? This cannot be undone.`, 'Delete save')) {
                  await deleteSave(s.id);
                  refresh();
                }
              }}
            >
              Delete
            </button>
          </div>
        ))}
        {!saves.length && <div className="mm-hint">No saved franchises yet.</div>}
      </div>
    </div>
  );
}

// ───────────────────────────── rosters ─────────────────────────────

const r99 = (v: number) => playerOvr(v);

function Rosters({ league, onBack }: { league: League; onBack: () => void }) {
  const [team, setTeam] = useState(0);
  const [tab, setTab] = useState<'F' | 'D' | 'G'>('F');
  const [open, setOpen] = useState<number | null>(null);
  const t = league.teams[team];
  const players = useMemo(
    () =>
      playersOf(league, team)
        .filter((p) => (tab === 'G' ? p.pos === 'G' : tab === 'D' ? p.pos === 'D' : isForward(p.pos)))
        .sort((a, b) => b.ca - a.ca),
    [league, team, tab],
  );
  const r = teamRatings(team);
  useKeys(
    (e) => {
      if (e.key === 'ArrowLeft') setTeam((x) => wrap(x - 1));
      else if (e.key === 'ArrowRight') setTeam((x) => wrap(x + 1));
    },
    open === null,
  );
  if (open !== null && players[open]) {
    return <PlayerCard league={league} players={players} index={open} setIndex={setOpen} onBack={() => setOpen(null)} />;
  }
  const cols: { k: string; f: (p: Player) => number }[] =
    tab === 'G'
      ? [
          { k: 'REF', f: (p) => p.attrs.reflexes },
          { k: 'POS', f: (p) => p.attrs.gPositioning },
          { k: 'GLV', f: (p) => p.attrs.glove },
          { k: 'BLK', f: (p) => p.attrs.blocker },
          { k: 'REB', f: (p) => p.attrs.reboundControl },
          { k: 'LAT', f: (p) => p.attrs.lateral },
        ]
      : [
          { k: 'SPD', f: (p) => (p.attrs.speed + p.attrs.acceleration) / 2 },
          { k: 'SHT', f: (p) => (p.attrs.wristAccuracy + p.attrs.wristPower) / 2 },
          { k: 'PAS', f: (p) => p.attrs.passing },
          { k: 'HND', f: (p) => (p.attrs.stickhandling + p.attrs.puckControl) / 2 },
          { k: 'OFF', f: (p) => p.attrs.offAwareness },
          { k: 'DEF', f: (p) => (p.attrs.defAwareness + p.attrs.defPositioning) / 2 },
          { k: 'PHY', f: (p) => (p.attrs.strength + p.attrs.bodyChecking) / 2 },
          ...(tab === 'F' ? [{ k: 'FO', f: (p: Player) => p.attrs.faceoffs }] : []),
        ];
  return (
    <div className="mm-screen">
      <ScreenHead title="Rosters" sub="Default league. ← → to change team · click a player for his full ratings." onBack={onBack} />
      <div className="mm-box" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <button className="mm-arrow" aria-label="Previous team" onClick={() => setTeam((x) => wrap(x - 1))}>
          ◀
        </button>
        <TeamLogo team={t} size={64} />
        <div style={{ minWidth: 0 }}>
          <div className="mm-pick" style={{ alignItems: 'flex-start', textAlign: 'left', gap: 2 }}>
            <span className="city">{t.city}</span>
            <span className="name">{t.name}</span>
          </div>
        </div>
        <button className="mm-arrow" aria-label="Next team" onClick={() => setTeam((x) => wrap(x + 1))}>
          ▶
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 18, font: '700 15px/1 var(--m-display)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--m-dim)' }}>
          {(
            [
              ['OVR', r.ovr],
              ['OFF', r.off],
              ['DEF', r.def],
              ['G', r.g],
            ] as const
          ).map(([k, v]) => (
            <span key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              {k}
              <span className="mm-ovr" style={{ fontSize: 20 }}>
                {v}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="mm-tabs">
        {(
          [
            ['F', 'Forwards'],
            ['D', 'Defense'],
            ['G', 'Goalies'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className="mm-box mm-table-wrap" style={{ padding: 0 }}>
        <table className="mm-table">
          <thead>
            <tr>
              <th className="n">#</th>
              <th>Player</th>
              <th>Pos</th>
              <th className="n">Age</th>
              <th>Type</th>
              <th className="n">OVR</th>
              {cols.map((c) => (
                <th key={c.k} className="n">
                  {c.k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {players.map((p, i) => (
              <tr key={p.id} className="mm-row-link" onClick={() => setOpen(i)}>
                <td className="n" style={{ color: 'var(--m-dim)' }}>
                  {p.number}
                </td>
                <td>
                  <button className="mm-name" onClick={(e) => { e.stopPropagation(); setOpen(i); }}>
                    {p.first} <b>{p.last}</b>
                  </button>
                </td>
                <td>{p.pos}</td>
                <td className="n">{league.season - p.birthYear}</td>
                <td style={{ color: 'var(--m-dim)' }}>{ARCHETYPES[p.archetype].label.replace('Goaltender ', '')}</td>
                <td className="n">
                  <span className="mm-ovr">{r99(p.ca)}</span>
                </td>
                {cols.map((c) => (
                  <td key={c.k} className="n">
                    {r99(c.f(p))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────── player card ─────────────────────────────

function PlayerCard({ league, players, index, setIndex, onBack }: { league: League; players: Player[]; index: number; setIndex: (i: number) => void; onBack: () => void }) {
  const p = players[index];
  const team = league.teams[p.teamId ?? 0];
  const step = (d: number) => setIndex((index + d + players.length) % players.length);
  useKeys((e) => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });
  return (
    <div className="mm-screen">
      <ScreenHead
        title="Player Card"
        sub={`${team.city} ${team.name} · ${index + 1} of ${players.length} · ← → previous / next player`}
        onBack={onBack}
        right={
          <>
            <button className="mm-arrow" aria-label="Previous player" onClick={() => step(-1)}>◀</button>
            <button className="mm-arrow" aria-label="Next player" onClick={() => step(1)}>▶</button>
          </>
        }
      />
      <PlayerCardView
        p={p}
        team={team}
        season={league.season}
        rate={(k) => ({ value: p.attrs[k], range: 0 })}
        ovr={String(playerOvr(p.ca))}
        potential={potentialGrade(p.pa, p.ca, league.season - p.birthYear)}
      />
    </div>
  );
}
