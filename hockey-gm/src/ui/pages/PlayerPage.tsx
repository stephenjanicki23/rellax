import { useState } from 'react';
import { useGame, mutate, toast, ask } from '../store';
import { navigate } from '../router';
import { Card, Headshot, Stars, TeamLogo, TeamLink, Pos, attrColor, Bar, LineChart, moraleLabel, Seg, Tabs } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { ContractDetails } from '../components/ContractDetails';
import { SystemFit, SystemFitStrip } from '../components/SystemFit';
import { ScoutReportCard } from '../components/ScoutReportCard';
import { ShotChart } from '../components/ShotChart';
import { PlayerAdvanced } from '../components/PlayerAdvanced';
import { ATTR_GROUPS, GOALIE_ATTR_GROUPS, type StatLine } from '../../engine/types';
import { attr20 } from '../../engine/player/ability';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { PERSONALITIES, TRAITS } from '../../engine/player/personality';
import { estimate, displayedAttr, scoutReport, knowledgeOf } from '../../engine/economy/scouting';
import { injuryLabel } from '../../engine/player/injuries';
import { points, savePct, gaa, gsax, fmtToi, addStatLine, emptyStatLine } from '../../engine/core/statline';
import { offerContract, makeOffer } from '../../engine/economy/freeAgency';
import { demote, promote, releasePlayer, signAhlPlayer } from '../../engine/economy/roster';
import { isUnsignedPick, signByLabel, signDraftPick } from '../../engine/economy/draftRights';
import { toggleTradeBlock } from '../../engine/ai/tradeMarket';
import { agentOf, AGENT_STYLES } from '../../engine/cba/agents';
import { heightLabel, weightLabel, seasonLabel, sv } from '../format';
import { countryLabel } from '../../engine/data/names';
import { attrLabel as label } from '../attrLabels';
import { PlayerCardView, potentialGrade } from '../menu/PlayerCard';
import { playerOvr } from '../menu/exhibition';
import '../menu/menu.css';


export function PlayerPage({ id }: { id: number }) {
  const { league, version } = useGame();
  const [neg, setNeg] = useState(false);
  const [statView, setStatView] = useState<'reg' | 'po'>('reg');
  const [view, setView] = useState<'card' | 'details' | 'advanced'>('card');
  const p = league.players[id];
  if (!p) return <div className="empty">Player not found (he may have left the league).</div>;
  const age = league.season - p.birthYear;
  const team = p.teamId !== null ? league.teams[p.teamId] : null;
  const e = estimate(league, p);
  const know = knowledgeOf(league, p);
  const rep = scoutReport(league, p);
  const mine = p.teamId === league.userTeamId;
  const groups = p.pos === 'G' ? GOALIE_ATTR_GROUPS : ATTR_GROUPS;
  const nat = countryLabel(p.nat);
  const cur = league.seasonStats[p.id];
  const career = p.career.filter((c) => (statView === 'po' ? c.playoffs : !c.playoffs));
  const rows: { season: string; teamId: number; s: StatLine; current?: boolean }[] = career.map((c) => ({ season: seasonLabel(c.season), teamId: c.teamId, s: c.stats }));
  if (cur && (statView === 'po' ? cur.po.gp : cur.reg.gp) && !p.career.some((c) => c.season === league.season)) rows.push({ season: `${seasonLabel(league.season)}*`, teamId: cur.teamId, s: statView === 'po' ? cur.po : cur.reg, current: true });
  const total = rows.reduce((acc, r) => addStatLine(acc, r.s), emptyStatLine());
  const morale = moraleLabel(p.morale);
  const isG = p.pos === 'G';

  return (
    <>
      <div className="page-head">
        <Headshot p={p} size={72} color={team?.colors[0]} />
        {team && <TeamLogo team={team} size={52} />}
        <div>
          <h1>
            <span className="dim">#{p.number}</span> {p.first} {p.last}
          </h1>
          <div className="sub row">
            <Pos pos={p.pos} /> {ARCHETYPES[p.archetype].label} · Age {age} · {nat} · {heightLabel(p.heightCm)}, {weightLabel(p.weightKg)} · {isG ? 'Catches' : 'Shoots'} {p.shoots === 'L' ? 'left' : 'right'} · {team ? <TeamLink league={league} id={team.id} /> : <span className="pill">{p.status === 'retired' ? `Retired ${p.retiredSeason}` : p.status === 'draft' ? 'Draft-eligible' : 'Free agent'}</span>}
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => navigate(`compare?ids=${p.id}`)}>Compare</button>
          {mine && p.status === 'active' && <button className="btn" onClick={() => { const r = mutate((l) => demote(l, p)); toast(r.message, r.ok ? 'info' : 'bad'); }}>Send to minors</button>}
          {mine && p.status === 'prospect' && p.contract && <button className="btn" onClick={() => mutate((l) => promote(l, p))}>Call up</button>}
          {mine && p.ahlContract && (
            <button className="btn primary" onClick={() => { const r = mutate((l) => signAhlPlayer(l, p)); toast(r.message, r.ok ? 'good' : 'bad'); }}>
              Sign NHL contract
            </button>
          )}
          {mine && (
            <button className="btn" onClick={() => { const on = mutate((l) => toggleTradeBlock(l, p.id)); toast(on ? `${p.last} is on the trade block — teams will call.` : `${p.last} is off the trade block.`, 'info'); }}>
              {(league.teams[league.userTeamId].tradeBlock ?? []).includes(p.id) ? 'Remove from trade block' : 'Add to trade block'}
            </button>
          )}
          {mine && isUnsignedPick(p) && (
            <button className="btn primary" onClick={() => { const r = mutate((l) => signDraftPick(l, p)); toast(r.message, r.ok ? 'good' : 'bad'); }}>
              Sign entry-level contract
            </button>
          )}
          {mine && p.contract && p.contract.years <= 1 && !p.contract.next && <button className="btn primary" onClick={() => setNeg(true)}>{p.contract.years <= 0 ? 'Re-sign' : 'Extend'}</button>}
          {mine && (
            <button className="btn" onClick={() => { mutate((l) => { const t = l.teams[l.userTeamId]; t.alternates = t.alternates.filter((x) => x !== p.id); t.captain = p.id; }); toast(`${p.last} named captain.`, 'good'); }}>
              Name captain
            </button>
          )}
          {mine && <button className="btn danger" onClick={async () => { if (await ask(`Release ${p.first} ${p.last}? He becomes a free agent.`, 'Release')) { const r = mutate((l) => releasePlayer(l, p, 'release')); toast(r.message, r.ok ? 'info' : 'bad'); } }}>Release</button>}
          {!mine && team && <button className="btn" onClick={() => navigate('trades')}>Trade for…</button>}
          {p.status === 'fa' && <button className="btn primary" onClick={() => setNeg(true)}>Make offer</button>}
        </div>
      </div>
      <Tabs value={view} onChange={setView} tabs={[{ id: 'card', label: 'Player card' }, { id: 'details', label: 'Stats, contract & scouting' }, { id: 'advanced', label: 'Advanced stats' }]} />
      {view === 'card' && <SystemFitStrip league={league} p={p} />}
      {view === 'card' ? (
        <PlayerCardView
          p={p}
          team={team}
          season={league.season}
          rate={(k) => displayedAttr(league, p, k)}
          ovr={e.exact || e.caLow === e.caHigh ? String(playerOvr(e.ca)) : `~${playerOvr(e.ca)}`}
          potential={potentialGrade(e.pa, e.ca, age)}
          personality={rep.personality}
          traits={know >= 50 ? p.traits.map((t) => TRAITS[t].label) : null}
          footnote={!e.exact && e.caLow !== e.caHigh ? `Scouting estimate (${Math.round(know)}% known). Ranges narrow as your scouts watch him.` : undefined}
        />
      ) : null}
      {view === 'card' && p.pos !== 'G' && (
        <div className="grid g2" style={{ marginTop: 14, alignItems: 'start' }}>
          <Card title={p.teamId === league.userTeamId || p.teamId === null ? 'System fit' : `System fit (${team?.abbr ?? ''})`}>
            <SystemFit league={league} p={p} />
          </Card>
          <ShotChart league={league} p={p} compact />
        </div>
      )}
      {view === 'advanced' && (
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <PlayerAdvanced league={league} p={p} version={version} />
          {p.pos !== 'G' && <ShotChart league={league} p={p} />}
        </div>
      )}
      {view !== 'details' ? null : (
      <div className="grid g-main">
        <div className="grid">
          <div className="grid g3">
            <Card>
              <div className="stat">
                <span className="k">Current ability</span>
                <Stars value={e.ca} />
                <span className="muted" style={{ fontSize: 12 }}>{e.exact ? `${e.ca} / 200` : `≈ ${e.caLow}–${e.caHigh}`}</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="k">Potential</span>
                <Stars value={e.pa} />
                <span className="muted" style={{ fontSize: 12 }}>{e.exact ? `${e.pa} / 200` : `≈ ${e.paLow}–${e.paHigh}`}</span>
              </div>
            </Card>
            <Card>
              <div className="stat">
                <span className="k">Scouting knowledge</span>
                <span className="v">{Math.round(know)}%</span>
                <Bar value={know} max={100} />
              </div>
            </Card>
          </div>
          <Card title="Attributes" right={!e.exact ? <span className="muted" style={{ fontSize: 12 }}>± ranges reflect scouting uncertainty</span> : <span className="muted" style={{ fontSize: 12 }}>1–20 scale (internal 0–200)</span>}>
            <div className="grid g3">
              {groups.map((g) => (
                <div key={g.label}>
                  <h3 style={{ marginBottom: 6 }}>{g.label}</h3>
                  {g.keys.map((k) => {
                    const d = displayedAttr(league, p, k);
                    const v = attr20(d.value);
                    const r = Math.round(d.range / 10);
                    return (
                      <div className="attr" key={k}>
                        <span className="n">{label(k)}</span>
                        <span className="v" style={{ color: attrColor(v) }}>{r > 0 ? `${Math.max(1, v - r)}-${Math.min(20, v + r)}` : v}</span>
                        <Bar value={d.value} color={attrColor(v)} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </Card>
          <Card title="Career statistics" right={<Seg value={statView} onChange={setStatView} options={[{ id: 'reg', label: 'Regular season' }, { id: 'po', label: 'Playoffs' }]} />} tight>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  {isG ? (
                    <tr><th>Season</th><th>Team</th><th className="num">GP</th><th className="num">W</th><th className="num">L</th><th className="num">OTL</th><th className="num">SV%</th><th className="num">GAA</th><th className="num">SO</th><th className="num">GSAx</th></tr>
                  ) : (
                    <tr><th>Season</th><th>Team</th><th className="num">GP</th><th className="num">G</th><th className="num">A</th><th className="num">P</th><th className="num">+/-</th><th className="num">PIM</th><th className="num">PPP</th><th className="num">SOG</th><th className="num">TOI</th><th className="num">ixG</th></tr>
                  )}
                </thead>
                <tbody>
                  {[...rows, ...(rows.length > 1 ? [{ season: 'Career', teamId: -1, s: total }] : [])].map((r, i) => (
                    <tr key={i} style={r.season === 'Career' ? { fontWeight: 700 } : undefined}>
                      <td>{r.season}</td>
                      <td>{r.teamId >= 0 ? <TeamLink league={league} id={r.teamId} short /> : ''}</td>
                      <td className="num">{r.s.gp}</td>
                      {isG ? (
                        <>
                          <td className="num">{r.s.w}</td><td className="num">{r.s.l}</td><td className="num">{r.s.otl}</td>
                          <td className="num">{sv(savePct(r.s))}</td><td className="num">{gaa(r.s).toFixed(2)}</td><td className="num">{r.s.so}</td><td className="num">{gsax(r.s).toFixed(1)}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{r.s.g}</td><td className="num">{r.s.a1 + r.s.a2}</td><td className="num"><b>{points(r.s)}</b></td>
                          <td className="num">{r.s.pm}</td><td className="num">{r.s.pim}</td><td className="num">{r.s.ppg + r.s.ppa}</td><td className="num">{r.s.sog}</td>
                          <td className="num">{r.s.gp ? fmtToi(r.s.toi / r.s.gp) : '—'}</td><td className="num">{r.s.ixg.toFixed(1)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                  {!rows.length && <tr><td colSpan={12} className="muted">No professional games played.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <ScoutReportCard league={league} p={p} />
          <Card title="Profile">
            <div className="kv">
              <span className="k">Personality</span>
              <span>{rep.personality ? <span title={PERSONALITIES[p.personality].description}>{rep.personality}</span> : <span className="dim">Unknown — scout him more</span>}</span>
              <span className="k">Traits</span>
              <span>{know >= 50 && p.traits.length ? p.traits.map((t) => <span key={t} className="pill" title={TRAITS[t].description} style={{ marginRight: 4 }}>{TRAITS[t].label}</span>) : <span className="dim">—</span>}</span>
              <span className="k">Morale</span>
              <span className={morale.cls}>{morale.text}</span>
              <span className="k">Form</span>
              <span className={p.form > 0.15 ? 'good' : p.form < -0.15 ? 'bad' : 'muted'}>{p.form > 0.3 ? 'Red hot' : p.form > 0.15 ? 'Hot' : p.form < -0.3 ? 'Ice cold' : p.form < -0.15 ? 'Cold' : 'Steady'}</span>
              <span className="k">Fatigue</span>
              <span>{Math.round(p.fatigue)} / 100</span>
              <span className="k">Health</span>
              <span className={p.injury ? 'bad' : 'good'}>{p.injury ? injuryLabel(p.injury) : 'Healthy'}</span>
              <span className="k">Injuries (career)</span>
              <span>{p.injuryHistory.length} ({p.injuryHistory.reduce((s, h) => s + h.days, 0)} days)</span>
              <span className="k">Draft</span>
              <span>{p.draft ? `${p.draft.season + 1} · Round ${p.draft.round}, #${p.draft.pick} by ${league.teams[p.draft.teamId].abbr}` : 'Undrafted'}</span>
              <span className="k">Agent</span>
              <span>{agentOf(league, p).name} <span className="muted">· {agentOf(league, p).agency} ({AGENT_STYLES[agentOf(league, p).style].label})</span></span>
              {p.holdout && (
                <>
                  <span className="k">Status</span>
                  <span className="warn">Holding out — refuses his qualifying offer</span>
                </>
              )}
              {isUnsignedPick(p) && (
                <>
                  <span className="k">Rights</span>
                  <span className="warn">Unsigned draft pick ({league.teams[p.rightsTeamId!].abbr}) · sign by {signByLabel(p)}</span>
                </>
              )}
              <span className="k">Pro seasons</span>
              <span>{p.proSeasons}</span>
            </div>
          </Card>
          <Card title="Contract">
            <ContractDetails league={league} p={p} />
          </Card>
          {(league.ahl?.stats[p.id] || p.ahlCareer?.length) && (
            <Card title="AHL" tight>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Season</th>
                    <th>Team</th>
                    <th className="num">GP</th>
                    {p.pos === 'G' ? (
                      <>
                        <th className="num">W-L-OT</th>
                        <th className="num">SV%</th>
                        <th className="num">GAA</th>
                        <th className="num">SO</th>
                      </>
                    ) : (
                      <>
                        <th className="num">G</th>
                        <th className="num">A</th>
                        <th className="num">PTS</th>
                        <th className="num">+/-</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {[...(p.ahlCareer ?? []), ...(league.ahl?.stats[p.id]?.gp ? [{ season: league.ahl.season, team: league.ahl.stats[p.id].team, stats: league.ahl.stats[p.id] }] : [])].map((r) => (
                    <tr key={`${r.season}${r.team}`}>
                      <td>{seasonLabel(r.season)}</td>
                      <td className="muted">{r.team}</td>
                      <td className="num">{r.stats.gp}</td>
                      {p.pos === 'G' ? (
                        <>
                          <td className="num">{r.stats.w}-{r.stats.l}-{r.stats.otl}</td>
                          <td className="num">{r.stats.sa ? (1 - r.stats.ga / r.stats.sa).toFixed(3).replace(/^0/, '') : '—'}</td>
                          <td className="num">{r.stats.gp ? (r.stats.ga / r.stats.gp).toFixed(2) : '—'}</td>
                          <td className="num">{r.stats.so}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{r.stats.g}</td>
                          <td className="num">{r.stats.a}</td>
                          <td className="num"><b>{r.stats.g + r.stats.a}</b></td>
                          <td className="num">{r.stats.pm}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
          <Card title="System fit">
            <SystemFit league={league} p={p} />
          </Card>
          {p.caHistory?.length > 0 && (
            <Card title="Development">
              <LineChart series={[{ label: 'Ability', color: 'var(--accent)', values: [...p.caHistory.map((h) => h[1]), p.ca] }]} />
            </Card>
          )}
          <Card title="Honours">
            {p.awards.length ? (
              <div className="list">
                {[...p.awards].reverse().map((a, i) => (
                  <div className="item" key={i}>
                    <span className="gold">♛</span> {a.award} <span className="dim" style={{ marginLeft: 'auto' }}>{seasonLabel(a.season)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="muted">No major awards yet.</div>
            )}
          </Card>
        </div>
      </div>
      )}
      {neg && (
        <NegotiationModal
          player={p}
          freeAgent={p.status === 'fa' && !(p.rfa && p.rightsTeamId === league.userTeamId)}
          title={p.status === 'fa' ? `Offer to ${p.first} ${p.last}` : `New contract for ${p.first} ${p.last}`}
          onClose={() => setNeg(false)}
          submit={(salary, years, x) => mutate((l) => (p.status === 'fa' ? makeOffer(l, l.userTeamId, p, salary, years, x) : offerContract(l, p, salary, years, x)))}
        />
      )}
    </>
  );
}
