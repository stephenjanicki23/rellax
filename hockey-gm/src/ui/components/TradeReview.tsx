import type { League, Player, Position } from '../../engine/types';
import { Headshot, Modal, PlayerLink, Pos, Stars, TeamLogo } from './common';
import { checkTrade, describeAsset, projectedPickNumber, type TradeAsset, type TradeProposal } from '../../engine/economy/trade';
import { estimate } from '../../engine/economy/scouting';
import { fmtMoney } from '../../engine/economy/contracts';
import { strengthOf } from '../../engine/team/strength';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { activeClause } from '../../engine/cba/contract';
import { capSeason } from '../../engine/cba/capManager';
import { playersOf } from '../../engine/league/helpers';
import { assists, gaa, points, savePct } from '../../engine/core/statline';
import { seasonLabel } from '../format';
import { href } from '../router';
import { lastRealSeason } from '../../engine/data/nhl/realStats';

/**
 * Side-by-side review of a trade before the GM commits: what he gets against
 * what he gives up (ability, potential, production, contract), plus the effect
 * on the roster, team strength and cap.
 */
export function TradeReview({
  league,
  proposal,
  note,
  onAccept,
  onCounter,
  onDecline,
  onClose,
  acceptLabel = 'Accept trade',
}: {
  league: League;
  /** `from` is the other club; `give` is what they send, `get` is what they receive from the user. */
  proposal: TradeProposal;
  note?: string;
  onAccept: () => void;
  onCounter?: () => void;
  onDecline?: () => void;
  onClose: () => void;
  acceptLabel?: string;
}) {
  const me = league.userTeamId;
  const them = proposal.from === me ? proposal.to : proposal.from;
  // Normalise to the user's point of view.
  const incoming = proposal.from === me ? proposal.get : proposal.give;
  const outgoing = proposal.from === me ? proposal.give : proposal.get;
  const chk = checkTrade(league, proposal);
  const myCap = chk.cap.find((c) => c.teamId === me);
  const retainedBy = (id: number) => proposal.retain?.find((r) => r.playerId === id)?.pct ?? 0;

  const roster = playersOf(league, me);
  const outIds = new Set(outgoing.filter((a) => a.kind === 'player').map((a) => a.id));
  const inPlayers = incoming.filter((a) => a.kind === 'player').map((a) => league.players[a.id]).filter((p) => p && p.status === 'active');
  const after = [...roster.filter((p) => !outIds.has(p.id)), ...inPlayers];
  const sBefore = strengthOf(roster);
  const sAfter = strengthOf(after);
  const posCount = (list: Player[], f: (pos: Position) => boolean) => list.filter((p) => f(p.pos)).length;

  return (
    <Modal title="Review trade" onClose={onClose} wide>
      <div className="stack" style={{ gap: 12 }}>
        {note && <div className="muted">{note}</div>}
        <div className="trade-review">
          <Side league={league} teamId={them} title="You get" assets={incoming} retainedBy={retainedBy} />
          <Side league={league} teamId={me} title="You give up" assets={outgoing} retainedBy={retainedBy} />
        </div>

        <div className="trade-impact">
          <Impact label="Team strength" before={sBefore.overall.toFixed(1)} after={sAfter.overall.toFixed(1)} delta={sAfter.overall - sBefore.overall} />
          <Impact label="Forwards" before={sBefore.forwards.toFixed(0)} after={sAfter.forwards.toFixed(0)} delta={sAfter.forwards - sBefore.forwards} />
          <Impact label="Defence" before={sBefore.defense.toFixed(0)} after={sAfter.defense.toFixed(0)} delta={sAfter.defense - sBefore.defense} />
          <Impact label="Goaltending" before={sBefore.goalie.toFixed(0)} after={sAfter.goalie.toFixed(0)} delta={sAfter.goalie - sBefore.goalie} />
          {myCap && <Impact label="Cap space" before={fmtMoney(myCap.spaceBefore)} after={fmtMoney(myCap.spaceAfter)} delta={myCap.spaceAfter - myCap.spaceBefore} money />}
          <Impact
            label="Roster F / D / G"
            before={`${posCount(roster, (p) => p !== 'D' && p !== 'G')} / ${posCount(roster, (p) => p === 'D')} / ${posCount(roster, (p) => p === 'G')}`}
            after={`${posCount(after, (p) => p !== 'D' && p !== 'G')} / ${posCount(after, (p) => p === 'D')} / ${posCount(after, (p) => p === 'G')}`}
            delta={0}
          />
        </div>

        {(chk.errors.length > 0 || chk.warnings.length > 0) && (
          <div className="stack" style={{ gap: 4 }}>
            {chk.errors.map((e) => (
              <span key={e} className="pill bad">{e}</span>
            ))}
            {chk.warnings.map((w) => (
              <span key={w} className="pill warn">{w}</span>
            ))}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {[...incoming, ...outgoing].filter((a) => a.kind === 'player').length >= 2 && (
            <a href={href(`compare?ids=${[...incoming, ...outgoing].filter((a) => a.kind === 'player').slice(0, 4).map((a) => a.id).join(',')}`)} style={{ marginRight: 'auto', fontSize: 13 }} onClick={onClose}>
              Compare these players →
            </a>
          )}
          {onDecline && (
            <button className="btn danger" onClick={onDecline}>
              Decline
            </button>
          )}
          {onCounter && (
            <button className="btn" onClick={onCounter}>
              Counter…
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Think it over
          </button>
          <button className="btn primary" disabled={!chk.ok} onClick={onAccept}>
            {acceptLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Impact({ label, before, after, delta, money }: { label: string; before: string; after: string; delta: number; money?: boolean }) {
  const eps = money ? 1 : 0.05;
  const cls = delta > eps ? 'good' : delta < -eps ? 'bad' : '';
  return (
    <div className="rank-tile">
      <div className="k">{label}</div>
      <div className="row" style={{ gap: 6, alignItems: 'baseline' }}>
        <span className="muted">{before}</span>
        <span className="dim">→</span>
        <b className={cls ? `txt-${cls}` : ''}>{after}</b>
      </div>
    </div>
  );
}

function Side({ league, teamId, title, assets, retainedBy }: { league: League; teamId: number; title: string; assets: TradeAsset[]; retainedBy: (id: number) => number }) {
  const team = league.teams[teamId];
  const players = assets.filter((a) => a.kind === 'player').map((a) => league.players[a.id]).filter(Boolean);
  const capIn = players.reduce((s, p) => s + (p.contract?.salary ?? 0) * (1 - retainedBy(p.id) / 100), 0);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <TeamLogo team={team} size={22} />
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {players.length ? `Cap hits ${fmtMoney(capIn)}` : ''}
        </span>
      </div>
      {assets.length === 0 && <div className="muted">Nothing</div>}
      {assets.map((a) =>
        a.kind === 'player' && league.players[a.id] ? (
          <PlayerCard key={`p${a.id}`} league={league} p={league.players[a.id]} retained={retainedBy(a.id)} />
        ) : (
          <div key={`k${a.id}`} className="trade-asset">
            <span className="pos">PK</span>
            <div className="stack" style={{ gap: 2 }}>
              <b>{describeAsset(league, a)}</b>
              <PickDetail league={league} id={a.id} />
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function PickDetail({ league, id }: { league: League; id: number }) {
  const pk = league.draftPicks.find((x) => x.id === id);
  if (!pk) return null;
  const bits = [`${pk.season + 1} draft`, pk.round === 1 ? `projected ~#${projectedPickNumber(league, pk)}` : null, pk.conditions?.join(' · ') || null].filter(Boolean);
  return <span className="muted" style={{ fontSize: 12 }}>{bits.join(' · ')}</span>;
}

function PlayerCard({ league, p, retained }: { league: League; p: Player; retained: number }) {
  const e = estimate(league, p);
  const age = league.season - p.birthYear;
  const cur = league.seasonStats[p.id];
  const last = [...p.career].reverse().find((c) => !c.playoffs);
  const line = cur?.reg.gp ? { label: `${seasonLabel(league.season)}`, s: cur.reg } : last ? { label: seasonLabel(last.season), s: last.stats } : null;
  // Before the save has a completed season, show last year's real NHL line too.
  const real = last ? null : lastRealSeason(p.nhlId);
  const clause = p.contract ? activeClause(p.contract, capSeason(league)) : null;
  const hit = p.contract ? p.contract.salary * (1 - retained / 100) : 0;
  return (
    <div className="trade-asset">
      <Headshot p={p} size={46} />
      <div className="stack" style={{ gap: 3, minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 6 }}>
          <Pos pos={p.pos} />
          <b>
            <PlayerLink p={p} />
          </b>
          {p.status === 'prospect' && <span className="pill">{p.contract ? 'minors' : 'unsigned'}</span>}
          {p.injury && <span className="pill bad">Injured {p.injury.daysRemaining}d</span>}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {age} yrs · {ARCHETYPES[p.archetype]?.label ?? ''}
        </div>
        <div className="row" style={{ gap: 12, fontSize: 12 }}>
          <span title={e.exact ? 'Current ability' : `Scouted current ability (${Math.round(e.knowledge)}% known)`}>
            <span className="muted">Now </span>
            <Stars value={e.ca} />
          </span>
          <span title={e.exact ? 'Potential' : 'Scouted potential'}>
            <span className="muted">Pot </span>
            <Stars value={e.pa} />
          </span>
        </div>
        {real && (
          <div style={{ fontSize: 12 }}>
            {real.goalie ? (
              <>
                <span className="muted">{seasonLabel(real.goalie.season)} (NHL): </span>
                {`${real.goalie.gp} GP · ${real.goalie.w}-${real.goalie.l}-${real.goalie.otl} · ${real.goalie.sv.toFixed(3).replace(/^0/, '')} SV% · ${real.goalie.gaa.toFixed(2)} GAA`}
              </>
            ) : real.skater ? (
              <>
                <span className="muted">{seasonLabel(real.skater.season)} (NHL): </span>
                {`${real.skater.gp} GP · ${real.skater.g} G · ${real.skater.a} A · ${real.skater.g + real.skater.a} PTS · ${real.skater.pm > 0 ? '+' : ''}${real.skater.pm}`}
              </>
            ) : null}
          </div>
        )}
        {line && (
          <div style={{ fontSize: 12 }}>
            <span className="muted">{line.label}: </span>
            {p.pos === 'G'
              ? `${line.s.gp} GP · ${line.s.w}-${line.s.l} · ${savePct(line.s).toFixed(3).replace(/^0/, '')} SV% · ${gaa(line.s).toFixed(2)} GAA`
              : `${line.s.gp} GP · ${line.s.g} G · ${assists(line.s)} A · ${points(line.s)} PTS · ${line.s.pm > 0 ? '+' : ''}${line.s.pm}`}
          </div>
        )}
        <div className="row" style={{ gap: 6, fontSize: 12 }}>
          {p.contract ? (
            <span>
              <span className="muted">Contract </span>
              <b>{fmtMoney(hit)}</b> × {p.contract.years} yr
              {p.contract.expiryStatus ? <span className="muted"> · then {p.contract.expiryStatus}</span> : null}
            </span>
          ) : (
            <span className="muted">No NHL contract</span>
          )}
          {retained > 0 && <span className="pill">{retained}% retained</span>}
          {clause && <span className="pill warn">{clause.kind}</span>}
        </div>
      </div>
    </div>
  );
}
