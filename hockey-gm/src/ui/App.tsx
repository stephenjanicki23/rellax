import { useEffect, useState, type ReactNode } from 'react';
import { useStore, runSim, nextPhase, saveNow, toast } from './store';
import { useRoute, href, navigate } from './router';
import { TeamLogo } from './components/common';
import { leagueDate, PHASE_LABEL, seasonLabel } from './format';
import { userGameToday } from '../engine/league/season';
import { recordString } from '../engine/league/standings';
import { currentPick } from '../engine/economy/draft';
import { expiringPlayers, FA_DAYS } from '../engine/economy/freeAgency';
import { capSpace } from '../engine/economy/contracts';
import { NewGame } from './pages/NewGame';
import { Dashboard } from './pages/Dashboard';
import { RosterPage } from './pages/Roster';
import { LinesPage } from './pages/Lines';
import { TacticsPage } from './pages/Tactics';
import { PlayersPage } from './pages/Players';
import { ProspectsPage } from './pages/Prospects';
import { ScoutingPage } from './pages/Scouting';
import { TradesPage } from './pages/Trades';
import { FreeAgencyPage } from './pages/FreeAgency';
import { DraftPage } from './pages/Draft';
import { SchedulePage } from './pages/Schedule';
import { StandingsPage } from './pages/Standings';
import { StatsPage } from './pages/Stats';
import { LeaguePage } from './pages/League';
import { NewsPage } from './pages/News';
import { HistoryPage } from './pages/History';
import { AnalyticsPage } from './pages/Analytics';
import { PlayerPage } from './pages/PlayerPage';
import { TeamPage } from './pages/TeamPage';
import { LiveGame } from './pages/LiveGame';
import { SettingsPage } from './pages/Settings';
import { ContractsPage } from './pages/Contracts';
import { GameRecap } from './pages/GameRecap';

const NAV: { section: string; items: { id: string; label: string; icon: string }[] }[] = [
  {
    section: 'Club',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: '◉' },
      { id: 'roster', label: 'Roster', icon: '☰' },
      { id: 'lines', label: 'Lines', icon: '≡' },
      { id: 'tactics', label: 'Tactics', icon: '⚑' },
      { id: 'prospects', label: 'Prospects', icon: '✦' },
      { id: 'contracts', label: 'Contracts', icon: '✎' },
    ],
  },
  {
    section: 'Front Office',
    items: [
      { id: 'scouting', label: 'Scouting', icon: '◎' },
      { id: 'trades', label: 'Trades', icon: '⇄' },
      { id: 'freeagency', label: 'Free Agency', icon: '✚' },
      { id: 'draft', label: 'Draft', icon: '⬇' },
    ],
  },
  {
    section: 'League',
    items: [
      { id: 'schedule', label: 'Schedule', icon: '▦' },
      { id: 'standings', label: 'Standings', icon: '▤' },
      { id: 'stats', label: 'Statistics', icon: '∑' },
      { id: 'players', label: 'Players', icon: '☺' },
      { id: 'league', label: 'League', icon: '⌂' },
      { id: 'news', label: 'News', icon: '✉' },
      { id: 'history', label: 'History', icon: '♛' },
    ],
  },
  {
    section: 'System',
    items: [
      { id: 'analytics', label: 'Sim Analytics', icon: '⌁' },
      { id: 'settings', label: 'Save & Settings', icon: '⚙' },
    ],
  },
];

export function App() {
  const { league, busy, toasts } = useStore();
  if (!league) {
    return (
      <>
        <NewGame />
        <Toasts toasts={toasts} />
      </>
    );
  }
  return (
    <div className="app">
      <TopBar />
      <Sidebar />
      <main className="main">
        <Routes />
      </main>
      {busy && (
        <div className="busy">
          <div className="box stack">
            <b>{busy.label}…</b>
            <div className="bar" style={{ height: 8 }}>
              <i style={{ width: `${Math.round(busy.progress * 100)}%` }} />
            </div>
            <div className="row muted">
              <span>{leagueDate(league)}</span>
              {busy.cancel && (
                <button className="btn small" style={{ marginLeft: 'auto' }} onClick={busy.cancel}>
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

function Toasts({ toasts }: { toasts: { id: number; text: string; kind: string }[] }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function Routes() {
  const r = useRoute();
  const pages: Record<string, ReactNode> = {
    dashboard: <Dashboard />,
    roster: <RosterPage />,
    lines: <LinesPage />,
    tactics: <TacticsPage />,
    players: <PlayersPage />,
    prospects: <ProspectsPage />,
    contracts: <ContractsPage />,
    scouting: <ScoutingPage />,
    trades: <TradesPage />,
    freeagency: <FreeAgencyPage />,
    draft: <DraftPage />,
    schedule: <SchedulePage />,
    standings: <StandingsPage />,
    stats: <StatsPage />,
    league: <LeaguePage />,
    news: <NewsPage />,
    history: <HistoryPage />,
    analytics: <AnalyticsPage />,
    settings: <SettingsPage />,
    player: <PlayerPage id={Number(r.param)} />,
    team: <TeamPage id={Number(r.param)} />,
    live: <LiveGame />,
    game: <GameRecap id={Number(r.param)} />,
  };
  return <>{pages[r.page] ?? <Dashboard />}</>;
}

function Sidebar() {
  const r = useRoute();
  const { league } = useStore();
  const badges: Record<string, string | null> = {};
  if (league) {
    if (league.phase === 'draft' && currentPick(league)?.ownerId === league.userTeamId) badges.draft = '!';
    if (league.phase === 'resign') {
      const n = expiringPlayers(league, league.userTeamId).length;
      badges.contracts = n ? String(n) : null;
    }
    if (league.phase === 'freeAgency') badges.freeagency = `D${league.faDay + 1}`;
    if (league.tradeOffers?.length) badges.trades = String(league.tradeOffers.length);
  }
  return (
    <nav className="sidebar">
      {NAV.map((s) => (
        <div key={s.section}>
          <div className="section">{s.section}</div>
          {s.items.map((it) => (
            <a key={it.id} href={href(it.id)} className={r.page === it.id ? 'active' : ''}>
              <span style={{ width: 14, textAlign: 'center', opacity: 0.8 }}>{it.icon}</span>
              {it.label}
              {badges[it.id] && <span className="badge-dot">{badges[it.id]}</span>}
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

function TopBar() {
  const { league, lastSaved } = useStore();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const close = () => setMenu(false);
    if (menu) window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);
  if (!league) return null;
  const team = league.teams[league.userTeamId];
  const rec = league.standings[team.id];
  const today = userGameToday(league);
  const inSeason = league.phase === 'regular' || league.phase === 'playoffs';

  const sim = async (k: Parameters<typeof runSim>[0]) => {
    setMenu(false);
    await runSim(k);
  };

  let primary: ReactNode = null;
  if (inSeason) {
    primary = today ? (
      <>
        <button className="btn primary" onClick={() => navigate('live')}>
          ▶ Play Game
        </button>
        <button className="btn" onClick={() => sim('day')}>
          Sim Game
        </button>
      </>
    ) : (
      <button className="btn primary" onClick={() => sim('toUserGame')}>
        ⏭ Next Game
      </button>
    );
  } else if (league.phase === 'draft') {
    primary = (
      <button className="btn primary" onClick={() => navigate('draft')}>
        Go to Draft
      </button>
    );
  } else if (league.phase === 'resign') {
    primary = (
      <button
        className="btn primary"
        onClick={() => {
          const n = expiringPlayers(league, league.userTeamId).length;
          if (n && !confirm(`${n} of your players are unsigned and will become free agents. Continue to free agency?`)) return;
          void nextPhase();
        }}
      >
        Open Free Agency
      </button>
    );
  } else if (league.phase === 'freeAgency') {
    primary = (
      <>
        <button className="btn primary" onClick={() => void nextPhase()}>
          Next FA Day ({league.faDay + 1}/{FA_DAYS})
        </button>
      </>
    );
  } else if (league.phase === 'preseason') {
    primary = (
      <button
        className="btn primary"
        onClick={() => {
          if (capSpace(league, league.userTeamId) < 0) {
            toast('You are over the salary cap. Trade, demote or release players before the season starts.', 'bad');
            return;
          }
          void nextPhase();
        }}
      >
        Start Season
      </button>
    );
  }

  return (
    <header className="topbar">
      <a className="brand" href={href('dashboard')} style={{ color: 'inherit', textDecoration: 'none' }}>
        <TeamLogo team={team} size={30} />
        <div className="stack" style={{ gap: 0 }}>
          <span>
            {team.city} {team.name}
          </span>
          <span className="muted" style={{ fontSize: 11, fontWeight: 500 }}>
            {rec ? recordString(rec) : '0-0-0'} · {rec ? rec.w * 2 + rec.otl : 0} pts
          </span>
        </div>
      </a>
      <div className="meta">
        <span>{seasonLabel(league.season)}</span>
        <span className="pill accent">{PHASE_LABEL[league.phase]}</span>
        <span>{leagueDate(league)}</span>
      </div>
      <div className="spacer" />
      <div className="row">
        {primary}
        {inSeason && (
          <div style={{ position: 'relative' }}>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                setMenu((m) => !m);
              }}
            >
              Sim ▾
            </button>
            {menu && (
              <div className="card stack" style={{ position: 'absolute', right: 0, top: 36, zIndex: 50, minWidth: 210, padding: 8, gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost" onClick={() => sim('day')}>One day</button>
                <button className="btn ghost" onClick={() => sim('week')}>One week</button>
                <button className="btn ghost" onClick={() => sim('month')}>One month</button>
                <button className="btn ghost" onClick={() => sim('toUserGame')}>To my next game</button>
                {league.phase === 'regular' && league.day <= league.tradeDeadlineDay && <button className="btn ghost" onClick={() => sim('deadline')}>To trade deadline</button>}
                {league.phase === 'regular' && <button className="btn ghost" onClick={() => sim('endRegular')}>To end of regular season</button>}
                <button className="btn ghost" onClick={() => sim('endPlayoffs')}>To end of playoffs</button>
              </div>
            )}
          </div>
        )}
        <button className="btn ghost" title={lastSaved ? `Last saved ${new Date(lastSaved).toLocaleTimeString()}` : 'Save'} onClick={() => void saveNow().then(() => toast('Game saved', 'good'))}>
          💾
        </button>
      </div>
    </header>
  );
}
