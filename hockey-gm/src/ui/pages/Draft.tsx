import { useMemo, useState } from 'react';
import { useGame, mutate, nextPhase, toast, ask } from '../store';
import { Card, Modal, PlayerLink, Pos, Stars, Table, TeamLink, TeamLogo, Bar, Tabs, type Column } from '../components/common';
import { currentPick, draftRankings, makeDraftPick, runDraftUntilUser, suggestPick } from '../../engine/economy/draft';
import { acceptDraftOffer, consensusRank, draftDayOffers, pickVerdict, simNextPick, type DraftOffer, type Verdict } from '../../engine/economy/draftDay';
import { estimate, knowledgeOf, scoutReport } from '../../engine/economy/scouting';
import { describeAsset, projectedPickNumber } from '../../engine/economy/trade';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { fullName } from '../../engine/player/ability';
import { playersOf } from '../../engine/league/helpers';
import type { League, Player } from '../../engine/types';
import { draftColumns } from '../components/DraftColumns';

type Tab = 'board' | 'mine' | 'order' | 'lottery' | 'recap';

const VerdictTag = ({ v }: { v: Verdict }) => (
  <span className={`pill ${v.tone === 'good' ? 'good' : v.tone === 'bad' ? 'bad' : ''}`} title={v.text}>
    {v.tag}
  </span>
);

export function DraftPage() {
  const { league, version } = useGame();
  const me = league.userTeamId;
  const inDraft = league.phase === 'draft';
  const pick = inDraft ? currentPick(league) : undefined;
  const onClock = pick?.ownerId === me;
  const dd = league.draftDay?.season === league.season ? league.draftDay : undefined;
  const lottery = league.lottery?.season === league.season ? league.lottery : undefined;
  const [tab, setTab] = useState<Tab>(inDraft && lottery && !dd?.selections.length ? 'lottery' : 'board');
  const [welcome, setWelcome] = useState<{ p: Player; pickNumber: number; consensus: number | null } | null>(null);
  const available = useMemo(() => draftRankings(league), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shortlist = useMemo(() => (league.scouting.shortlist ?? []).map((id) => league.players[id]).filter((p) => p?.status === 'draft'), [league, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestion = onClock ? suggestPick(league) : undefined;
  const offers = useMemo(() => (onClock ? draftDayOffers(league) : []), [league, version, onClock]); // eslint-disable-line react-hooks/exhaustive-deps
  const myPicks = league.draftPicks.filter((p) => p.ownerId === me && p.season === league.season && p.playerId === undefined);

  const draft = (p: Player) => {
    if (!pick || !onClock) return;
    const n = pick.pickNumber ?? 0;
    const consensus = consensusRank(league, p.id);
    mutate((l) => makeDraftPick(l, pick.id, p.id));
    setWelcome({ p, pickNumber: n, consensus });
  };
  const nextPick = () => mutate((l) => simNextPick(l));
  const cols: Column<Player>[] = [
    { key: 'rk', label: '#', num: true, render: (p) => consensusRank(league, p.id) ?? '—', sort: (p) => consensusRank(league, p.id) ?? 999, defaultDesc: false },
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    { key: 'name', label: 'Prospect', render: (p) => <PlayerLink p={p} /> },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear },
    ...draftColumns(league),
    { key: 'type', label: 'Type', render: (p) => <span className="muted">{ARCHETYPES[p.archetype].label}</span> },
    { key: 'ca', label: 'Now', render: (p) => { const e = estimate(league, p); return <Stars value={e.ca} range={[e.caLow, e.caHigh]} />; }, sort: (p) => estimate(league, p).ca },
    { key: 'pa', label: 'Ceiling', render: (p) => { const e = estimate(league, p); return <Stars value={e.pa} range={[e.paLow, e.paHigh]} />; }, sort: (p) => estimate(league, p).pa },
    { key: 'kn', label: 'Scouted', render: (p) => <div style={{ width: 60 }}><Bar value={knowledgeOf(league, p)} max={100} /></div> },
    // The long report column is left off on draft night to keep the board compact (it's on each prospect's page).
    ...(inDraft ? [] : [{ key: 'rep', label: 'Scouting report', render: (p: Player) => <span className="muted" style={{ whiteSpace: 'normal', fontSize: 12 }}>{scoutReport(league, p).summary}</span> }]),
    ...(onClock ? [{ key: 'act', label: '', render: (p: Player) => <button className="btn small primary" onClick={() => draft(p)}>Draft</button> }] : []),
  ];
  const tabs: { id: Tab; label: string }[] = [
    { id: 'board', label: inDraft ? 'Big board' : 'Prospects' },
    { id: 'mine', label: `My shortlist (${shortlist.length})` },
    { id: 'order', label: 'Draft order & picks' },
    ...(lottery ? [{ id: 'lottery' as const, label: 'Lottery' }] : []),
    ...(dd?.selections.length ? [{ id: 'recap' as const, label: dd.grades ? 'Draft grades' : 'Recap' }] : []),
  ];
  const team = pick ? league.teams[pick.ownerId] : undefined;
  return (
    <>
      <div className="page-head">
        <h1>{inDraft ? `${league.season + 1} Entry Draft` : 'Draft'}</h1>
        <span className="sub">
          {inDraft
            ? pick
              ? `Round ${pick.round}`
              : 'The draft is complete.'
            : dd?.selections.length
              ? `The ${league.season + 1} draft is done: you made ${dd.selections.filter((x) => x.teamId === me).length} picks.`
              : `The draft takes place after the playoffs. You hold ${league.draftPicks.filter((p) => p.ownerId === me && p.season === league.season).length} picks this year.`}
        </span>
        <div className="actions">
          {inDraft && pick && !onClock && (
            <>
              <button className="btn" onClick={nextPick}>Next pick</button>
              <button className="btn primary" onClick={() => mutate((l) => runDraftUntilUser(l))}>Sim to my pick</button>
            </>
          )}
          {inDraft && onClock && suggestion && (
            <button className="btn" onClick={() => draft(suggestion)}>
              Take scouts' choice: {suggestion.last}
            </button>
          )}
          {inDraft && (
            <button
              className="btn"
              onClick={async () => {
                if (myPicks.length && !(await ask('Auto-draft your remaining picks using your scouts’ board?', 'Auto-draft'))) return;
                mutate((l) => runDraftUntilUser(l, true));
                void nextPhase();
              }}
            >
              {pick ? 'Auto-draft remaining' : 'Finish draft'}
            </button>
          )}
        </div>
      </div>
      {inDraft && pick && team && (
        <div className={`clock-banner${onClock ? ' mine' : ''}`} style={{ '--tc': team.colors[0] } as React.CSSProperties}>
          <TeamLogo team={team} size={46} />
          <div className="stack" style={{ gap: 2 }}>
            <span className="cb-k">{onClock ? "You're on the clock" : 'On the clock'}</span>
            <b className="cb-team">
              {team.city} {team.name}
            </b>
            {pick.originalTeamId !== pick.ownerId && <span className="muted" style={{ fontSize: 12 }}>Pick acquired from {league.teams[pick.originalTeamId].city}</span>}
          </div>
          <div className="cb-pick">
            <span>Pick</span>
            <b>{pick.pickNumber}</b>
          </div>
        </div>
      )}
      {!inDraft && league.draftPicks.some((p) => p.ownerId === me && p.season === league.season) && (
        <div className="banner">
          <span className="muted">Your picks:</span>
          {league.draftPicks
            .filter((p) => p.ownerId === me && p.season === league.season)
            .map((p) => (
              <span key={p.id} className="pill accent">
                {describeAsset(league, { kind: 'pick', id: p.id })}
                {p.round === 1 ? ` (~#${projectedPickNumber(league, p)})` : ''}
              </span>
            ))}
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <div className={inDraft ? 'grid g-main' : ''} style={{ alignItems: 'start' }}>
        <div>
          {(tab === 'board' || tab === 'mine') && (
            <Card tight>
              <Table rows={tab === 'mine' ? shortlist : available} columns={cols} rowKey={(p) => p.id} limit={250} initialSort={{ key: 'rk', desc: false }} empty={tab === 'mine' ? 'Star prospects (☆) to build your own list.' : undefined} />
            </Card>
          )}
          {tab === 'order' && <OrderTab league={league} />}
          {tab === 'lottery' && lottery && <LotteryTab league={league} />}
          {tab === 'recap' && <RecapTab league={league} />}
        </div>
        {inDraft && (
          <div className="grid" style={{ alignContent: 'start' }}>
            {onClock && offers.length > 0 && <OffersCard league={league} offers={offers} />}
            <LiveFeed league={league} />
            <NeedsCard league={league} />
            <Card title={`Your remaining picks (${myPicks.length})`} tight>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, padding: 10 }}>
                {myPicks.length ? myPicks.map((p) => <span key={p.id} className="pill accent">No. {p.pickNumber} · R{p.round}</span>) : <span className="muted">None left this year.</span>}
              </div>
            </Card>
          </div>
        )}
      </div>
      {welcome && <WelcomeModal league={league} {...welcome} onClose={() => setWelcome(null)} />}
    </>
  );
}

function OrderTab({ league }: { league: League }) {
  const me = league.userTeamId;
  const order = league.draftOrder.map((id) => league.draftPicks.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const dd = league.draftDay?.season === league.season ? league.draftDay : undefined;
  if (!order.length && !dd?.selections.length) return <Card><div className="empty">The draft order is set when the playoffs end.</div></Card>;
  const rows = order.length ? order.map((pk) => ({ pickNumber: pk.pickNumber ?? 0, round: pk.round, owner: pk.ownerId, from: pk.originalTeamId !== pk.ownerId ? pk.originalTeamId : undefined, playerId: pk.playerId })) : dd!.selections.map((s) => ({ pickNumber: s.pickNumber, round: s.round, owner: s.teamId, from: s.fromTeamId, playerId: s.playerId as number | undefined }));
  return (
    <Card tight>
      <table className="tbl">
        <thead>
          <tr><th>Pick</th><th>Team</th><th>Selection</th><th>Pos</th><th>Board</th><th>Verdict</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = r.playerId !== undefined ? league.players[r.playerId] : undefined;
            const c = p ? (dd?.selections.find((s) => s.playerId === p.id)?.consensus ?? null) : null;
            return (
              <tr key={r.pickNumber} className={r.owner === me ? 'me' : ''}>
                <td>{r.pickNumber} <span className="dim">R{r.round}</span></td>
                <td><TeamLink league={league} id={r.owner} logo short />{r.from !== undefined && <span className="dim"> (from {league.teams[r.from].abbr})</span>}</td>
                <td>{p ? <PlayerLink p={p} /> : <span className="dim">—</span>}</td>
                <td>{p && <Pos pos={p.pos} />}</td>
                <td className="muted">{p ? (c ?? '—') : ''}</td>
                <td>{p && <VerdictTag v={pickVerdict(r.pickNumber, c)} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** Lottery night: the odds, then the order revealed from the last lottery pick to No. 1. */
function LotteryTab({ league }: { league: League }) {
  const lot = league.lottery!;
  const [shown, setShown] = useState(0);
  const n = lot.order.length;
  const pre = new Map(lot.entries.map((e) => [e.teamId, e]));
  const me = league.userTeamId;
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <Card
        title="Lottery results"
        right={
          shown < n ? (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn small primary" onClick={() => setShown((s) => s + 1)}>
                Reveal No. {n - shown}
              </button>
              <button className="btn small" onClick={() => setShown(n)}>Reveal all</button>
            </div>
          ) : null
        }
        tight
      >
        <table className="tbl">
          <tbody>
            {lot.order.map((teamId, i) => {
              const revealed = i >= n - shown;
              const e = pre.get(teamId);
              const jump = e ? e.pre - (i + 1) : 0;
              return (
                <tr key={i} className={revealed && teamId === me ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td>{revealed ? <TeamLink league={league} id={teamId} logo /> : <span className="dim">? ? ?</span>}</td>
                  <td className="num">
                    {revealed && jump > 0 && <span className="pill good">▲ {jump} from No. {e!.pre}</span>}
                    {revealed && jump < 0 && <span className="pill bad">▼ {-jump}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown >= n && lot.winners[0] !== undefined && (
          <div className="muted" style={{ padding: '8px 12px', fontSize: 13 }}>
            {league.teams[lot.winners[0]].city} win the lottery{pre.get(lot.winners[0]) ? `, jumping from No. ${pre.get(lot.winners[0])!.pre}` : ''}.
          </div>
        )}
      </Card>
      <Card title="Odds of winning the first draw" tight>
        <table className="tbl">
          <thead>
            <tr><th>Pre</th><th>Team</th><th className="num">Odds</th></tr>
          </thead>
          <tbody>
            {lot.entries.map((e) => (
              <tr key={e.teamId} className={e.teamId === me ? 'me' : ''}>
                <td className="rank">{e.pre}</td>
                <td><TeamLink league={league} id={e.teamId} logo short /></td>
                <td className="num">{e.odds.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>Non-playoff teams in reverse order of the standings. {league.config.draft.lotteryDraws} draws; a team can move up at most into the drawn spots.</div>
      </Card>
    </div>
  );
}

function LiveFeed({ league }: { league: League }) {
  const dd = league.draftDay?.season === league.season ? league.draftDay : undefined;
  const sel = dd ? [...dd.selections].reverse().slice(0, 8) : [];
  return (
    <Card title="Live from the draft floor" tight>
      {!sel.length ? (
        <div className="muted" style={{ padding: 12 }}>The first pick is coming up.</div>
      ) : (
        <div className="list">
          {sel.map((s) => {
            const p = league.players[s.playerId];
            const v = pickVerdict(s.pickNumber, s.consensus);
            return (
              <div key={s.pickId} className={`item feed-pick${s.teamId === league.userTeamId ? ' me' : ''}`}>
                <b style={{ width: 30 }}>{s.pickNumber}</b>
                <TeamLogo team={league.teams[s.teamId]} size={20} />
                <div className="stack" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                  <span>{p ? <><Pos pos={p.pos} /> <PlayerLink p={p} /></> : '—'}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{v.text}</span>
                </div>
                <VerdictTag v={v} />
              </div>
            );
          })}
        </div>
      )}
      {dd && dd.trades.length > 0 && <div className="muted" style={{ padding: '6px 12px', fontSize: 12 }}>Deals: {dd.trades.join('; ')}</div>}
    </Card>
  );
}

function OffersCard({ league, offers }: { league: League; offers: DraftOffer[] }) {
  const cur = currentPick(league)!;
  return (
    <Card title="The phone is ringing" tight>
      <div className="list">
        {offers.map((o) => {
          const t = league.teams[o.teamId];
          const target = league.players[o.targetId];
          return (
            <div key={o.teamId} className="item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 6 }}>
              <div className="row" style={{ gap: 8 }}>
                <TeamLogo team={t} size={22} />
                <b>{t.city} want to move up to No. {cur.pickNumber}</b>
              </div>
              <span style={{ fontSize: 13 }}>
                They offer: {o.picks.map((id) => describeAsset(league, { kind: 'pick', id })).join(' + ')}
              </span>
              {target && <span className="muted" style={{ fontSize: 12 }}>Word is they're after {fullName(target)} ({target.pos}).</span>}
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn small primary"
                  onClick={() => {
                    const r = mutate((l) => acceptDraftOffer(l, o));
                    toast(r.message, r.ok ? 'good' : 'bad');
                  }}
                >
                  Accept and move back
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Organisational depth by position: where the system is thin. */
function NeedsCard({ league }: { league: League }) {
  const me = league.userTeamId;
  const org = playersOf(league, me, ['active', 'prospect']);
  const groups: { label: string; test: (p: Player) => boolean; target: number }[] = [
    { label: 'Centre', test: (p) => p.pos === 'C', target: 9 },
    { label: 'Wing', test: (p) => p.pos === 'LW' || p.pos === 'RW', target: 16 },
    { label: 'Defence', test: (p) => p.pos === 'D', target: 14 },
    { label: 'Goalie', test: (p) => p.pos === 'G', target: 5 },
  ];
  const rows = groups.map((g) => {
    const all = org.filter(g.test);
    const young = all.filter((p) => p.status === 'prospect' || league.season - p.birthYear <= 22);
    return { ...g, nhl: all.filter((p) => p.status === 'active').length, prospects: all.filter((p) => p.status === 'prospect').length, young: young.length, need: g.target - all.length };
  });
  const top = [...rows].sort((a, b) => b.need - a.need)[0];
  return (
    <Card title="Organisational depth" tight>
      <table className="tbl">
        <thead>
          <tr><th>Position</th><th className="num">NHL</th><th className="num">Prospects</th><th className="num">22 &amp; under</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className={r === top && r.need > 0 ? 'me' : ''}>
              <td>{r.label}</td>
              <td className="num">{r.nhl}</td>
              <td className="num">{r.prospects}</td>
              <td className="num">{r.young}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ padding: '6px 12px 10px', fontSize: 12 }}>{top.need > 0 ? `Thinnest spot in the system: ${top.label.toLowerCase()}.` : 'The system is well stocked at every position: take the best player available.'}</div>
    </Card>
  );
}

function RecapTab({ league }: { league: League }) {
  const dd = league.draftDay!;
  const me = league.userTeamId;
  const mine = dd.selections.filter((s) => s.teamId === me);
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <Card title="Your class" tight>
        <table className="tbl">
          <tbody>
            {mine.map((s) => {
              const p = league.players[s.playerId];
              const v = pickVerdict(s.pickNumber, s.consensus);
              return (
                <tr key={s.pickId}>
                  <td>{s.pickNumber} <span className="dim">R{s.round}</span></td>
                  <td>{p && <><Pos pos={p.pos} /> <PlayerLink p={p} /></>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{v.text}</td>
                  <td><VerdictTag v={v} /></td>
                </tr>
              );
            })}
            {!mine.length && <tr><td className="muted">You haven't made a selection.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card title={dd.grades ? 'Draft grades' : 'Grades come out when the draft closes'} tight>
        {dd.grades ? (
          <table className="tbl">
            <tbody>
              {dd.grades.map((g, i) => (
                <tr key={g.teamId} className={g.teamId === me ? 'me' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td><TeamLink league={league} id={g.teamId} logo short /></td>
                  <td className="num"><b className={g.grade.startsWith('A') ? 'txt-good' : g.grade.startsWith('C') || g.grade === 'D' ? 'txt-bad' : ''}>{g.grade}</b></td>
                  <td className="num muted">{g.picks} picks</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted" style={{ padding: 12 }}>Teams are graded against the consensus board as it stood when the draft opened.</div>
        )}
      </Card>
    </div>
  );
}

function WelcomeModal({ league, p, pickNumber, consensus, onClose }: { league: League; p: Player; pickNumber: number; consensus: number | null; onClose: () => void }) {
  const v = pickVerdict(pickNumber, consensus);
  const rep = scoutReport(league, p);
  const e = estimate(league, p);
  const team = league.teams[league.userTeamId];
  return (
    <Modal title={`With pick No. ${pickNumber}…`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12 }}>
          <TeamLogo team={team} size={44} />
          <div className="stack" style={{ gap: 2 }}>
            <b style={{ fontSize: 20 }}>{fullName(p)}</b>
            <span className="muted">
              <Pos pos={p.pos} /> {ARCHETYPES[p.archetype].label} · Age {league.season - p.birthYear}
              {p.junior ? ` · ${p.junior}` : ''}
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <VerdictTag v={v} />
          <span className="muted" style={{ fontSize: 13 }}>{v.text}</span>
        </div>
        <span>{rep.projection}</span>
        <div className="row" style={{ gap: 16 }}>
          <span className="muted">Now</span> <Stars value={e.ca} range={[e.caLow, e.caHigh]} />
          <span className="muted">Ceiling</span> <Stars value={e.pa} range={[e.paLow, e.paHigh]} />
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <a className="btn" href={`#/player/${p.id}`} onClick={onClose}>Full scouting report</a>
          <button className="btn primary" onClick={onClose}>Back to the draft</button>
        </div>
      </div>
    </Modal>
  );
}
