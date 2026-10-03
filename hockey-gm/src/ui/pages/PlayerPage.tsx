import { useState } from 'react';
import { useGame, mutate, toast } from '../store';
import { navigate } from '../router';
import { Card, Stars, TeamLogo, TeamLink, Pos, attrColor, Bar, LineChart, moraleLabel, Seg } from '../components/common';
import { NegotiationModal } from '../components/Negotiation';
import { ATTR_GROUPS, GOALIE_ATTR_GROUPS, type AttrKey, type StatLine } from '../../engine/types';
import { attr20, roleForAbility } from '../../engine/player/ability';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { PERSONALITIES, TRAITS } from '../../engine/player/personality';
import { estimate, displayedAttr, scoutReport, knowledgeOf } from '../../engine/economy/scouting';
import { fmtMoney, marketValue, isRFA } from '../../engine/economy/contracts';
import { injuryLabel } from '../../engine/player/injuries';
import { points, savePct, gaa, gsax, fmtToi, addStatLine, emptyStatLine } from '../../engine/core/statline';
import { offerContract, makeOffer } from '../../engine/economy/freeAgency';
import { demote, promote, releasePlayer } from '../../engine/economy/roster';
import { heightLabel, weightLabel, seasonLabel, sv } from '../format';
import { NAME_POOLS } from '../../engine/data/names';

const LABELS: Partial<Record<AttrKey, string>> = {
  wristPower: 'Wrist Shot Power', wristAccuracy: 'Wrist Shot Accuracy', slapPower: 'Slap Shot Power', slapAccuracy: 'Slap Shot Accuracy',
  oneTimer: 'One-Timer', offAwareness: 'Offensive Awareness', defAwareness: 'Defensive Awareness', decisionMaking: 'Decision Making',
  hockeySense: 'Hockey Sense', bodyChecking: 'Body Checking', stickChecking: 'Stick Checking', shotBlocking: 'Shot Blocking',
  defPositioning: 'Defensive Positioning', gPositioning: 'Positioning', reboundControl: 'Rebound Control', puckHandling: 'Puck Handling',
  highDanger: 'High-Danger Saves', lateral: 'Lateral Movement', puckControl: 'Puck Control', shotSelection: 'Shot Selection', clutch: 'Clutch',
};
const label = (k: AttrKey) => LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

export function PlayerPage({ id }: { id: number }) {
  const { league } = useGame();
  const [neg, setNeg] = useState(false);
  const [statView, setStatView] = useState<'reg' | 'po'>('reg');
  const p = league.players[id];
  if (!p) return <div className="empty">Player not found (he may have left the league).</div>;
  const age = league.season - p.birthYear;
  const team = p.teamId !== null ? league.teams[p.teamId] : null;
  const e = estimate(league, p);
  const know = knowledgeOf(league, p);
  const rep = scoutReport(league, p);
  const mine = p.teamId === league.userTeamId;
  const groups = p.pos === 'G' ? GOALIE_ATTR_GROUPS : ATTR_GROUPS;
  const nat = NAME_POOLS.find((n) => n.code === p.nat)?.label ?? p.nat;
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
          {mine && p.status === 'active' && <button className="btn" onClick={() => mutate((l) => demote(l, p))}>Send to minors</button>}
          {mine && p.status === 'prospect' && <button className="btn" onClick={() => mutate((l) => promote(l, p))}>Call up</button>}
          {mine && p.contract && p.contract.years <= 1 && !p.contract.next && <button className="btn primary" onClick={() => setNeg(true)}>{p.contract.years <= 0 ? 'Re-sign' : 'Extend'}</button>}
          {mine && (
            <button className="btn" onClick={() => { mutate((l) => { const t = l.teams[l.userTeamId]; t.alternates = t.alternates.filter((x) => x !== p.id); t.captain = p.id; }); toast(`${p.last} named captain.`, 'good'); }}>
              Name captain
            </button>
          )}
          {mine && <button className="btn danger" onClick={() => { if (confirm(`Release ${p.first} ${p.last}?`)) mutate((l) => releasePlayer(l, p, 'release')); }}>Release</button>}
          {!mine && team && <button className="btn" onClick={() => navigate('trades')}>Trade for…</button>}
          {p.status === 'fa' && <button className="btn primary" onClick={() => setNeg(true)}>Make offer</button>}
        </div>
      </div>
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
          <Card title="Scouting report">
            <div className="stack">
              <span>{rep.projection}</span>
              {rep.strengths.length > 0 && <span><span className="good">Strengths:</span> {rep.strengths.join(', ')}</span>}
              {rep.weaknesses.length > 0 && <span><span className="bad">Weaknesses:</span> {rep.weaknesses.join(', ')}</span>}
              {rep.injury && <span className="muted">{rep.injury}</span>}
              <span className="muted" style={{ fontSize: 12 }}>{ARCHETYPES[p.archetype].description}</span>
              <span className="muted" style={{ fontSize: 12 }}>Role today: {roleForAbility(p.pos, e.ca)}</span>
            </div>
          </Card>
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
              <span>{p.draft ? `${p.draft.season} · Round ${p.draft.round}, #${p.draft.pick} by ${league.teams[p.draft.teamId].abbr}` : 'Undrafted'}</span>
              <span className="k">Pro seasons</span>
              <span>{p.proSeasons}</span>
            </div>
          </Card>
          <Card title="Contract">
            {p.contract ? (
              <div className="kv">
                <span className="k">Cap hit</span>
                <b>{fmtMoney(p.contract.salary)}</b>
                <span className="k">Years left</span>
                <span>{p.contract.years}</span>
                <span className="k">Type</span>
                <span>{p.contract.type}{p.contract.ntc ? ' · No-trade clause' : ''}</span>
                {p.contract.next && (<><span className="k">Extension</span><span>{fmtMoney(p.contract.next.salary)} × {p.contract.next.years}</span></>)}
                <span className="k">Expiry status</span>
                <span>{isRFA(p, league.season + p.contract.years) ? 'RFA' : 'UFA'}</span>
                <span className="k">Market value</span>
                <span className="muted">{fmtMoney(marketValue(p, league))}</span>
              </div>
            ) : (
              <div className="muted">Not under contract. Market value ≈ {fmtMoney(marketValue(p, league))}</div>
            )}
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
      {neg && (
        <NegotiationModal
          player={p}
          freeAgent={p.status === 'fa'}
          title={p.status === 'fa' ? `Offer to ${p.first} ${p.last}` : `New contract for ${p.first} ${p.last}`}
          onClose={() => setNeg(false)}
          submit={(salary, years) => mutate((l) => (p.status === 'fa' ? makeOffer(l, l.userTeamId, p, salary, years) : offerContract(l, p, salary, years)))}
        />
      )}
    </>
  );
}
