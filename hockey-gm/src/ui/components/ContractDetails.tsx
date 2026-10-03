import type { Contract, League, Player } from '../../engine/types';
import { aav, activeClause, fullCapHit, holderCapHit, yearsOf, totalValue } from '../../engine/cba/contract';
import { capSeason } from '../../engine/cba/capManager';
import { formatMoney as fm } from '../../engine/cba/contractService';
import { arbitrationEligible, determineFreeAgentStatus, waiverStatus } from '../../engine/cba/rulesEngine';
import { contractValue } from '../../engine/cba/market';
import { mntcBlockedTeams } from '../../engine/cba/tradeRules';
import { accruedSeasons, nhlGames } from '../../engine/cba/experience';
import { seasonLabel } from '../format';

function YearTable({ c, season, title }: { c: Contract; season: number; title: string }) {
  const ys = yearsOf(c);
  const hasPerf = ys.some((y) => y.perfBonus > 0);
  const hasMinor = ys.some((y) => y.minorSalary !== undefined);
  const hit = fullCapHit(c);
  return (
    <div style={{ marginTop: 8, overflowX: 'auto' }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{title}</div>
      <table className="tbl" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Season</th>
            <th className="num">Salary</th>
            <th className="num">Signing bonus</th>
            {hasPerf && <th className="num">Perf. bonus</th>}
            {hasMinor && <th className="num">Minors</th>}
            <th className="num">Cap hit</th>
            <th>Clause</th>
          </tr>
        </thead>
        <tbody>
          {ys.map((y) => {
            const cl = activeClause(c, y.season);
            return (
              <tr key={y.season} className={y.season === season ? 'me' : y.season < season ? 'dim' : ''}>
                <td>{seasonLabel(y.season)}</td>
                <td className="num">{fm(y.salary)}</td>
                <td className="num">{y.signingBonus ? fm(y.signingBonus) : '—'}</td>
                {hasPerf && <td className="num">{y.perfBonus ? fm(y.perfBonus) : '—'}</td>}
                {hasMinor && <td className="num">{y.minorSalary !== undefined ? fm(y.minorSalary) : '—'}</td>}
                <td className="num">{fm(hit)}</td>
                <td>{cl ? `${cl.kind}${cl.teams ? ` (${cl.teams})` : ''}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ORIGIN: Record<string, string> = { import: 'Contract', signing: 'Signing', extension: 'Extension', arbitration: 'Arbitration', qualifyingOffer: 'QO', offerSheet: 'Offer sheet', elc: 'ELC' };

/** Full contract view for the player profile: terms, year-by-year structure, CBA status and history. */
export function ContractDetails({ league, p }: { league: League; p: Player }) {
  const season = capSeason(league);
  const c = p.contract;
  const value = contractValue(p, league);
  const fa = determineFreeAgentStatus(p, season, league);
  const arb = arbitrationEligible(p, season);
  const ws = c ? waiverStatus(p, season, league) : null;
  const cl = c ? activeClause(c, season) : null;
  const blocked = cl?.kind === 'M-NTC' ? mntcBlockedTeams(league, p) : [];
  return (
    <div className="stack" style={{ gap: 8 }}>
      {c ? (
        <div className="kv">
          <span className="k">Cap hit</span>
          <b>
            {fm(holderCapHit(c))}
            {(c.retained ?? []).length > 0 && <span className="muted"> (full {fm(fullCapHit(c))}; {c.retained!.map((r) => `${Math.round(r.pct * 100)}% retained by ${league.teams[r.teamId]?.abbr}`).join(', ')})</span>}
          </b>
          <span className="k">Contract</span>
          <span>
            {yearsOf(c).length} yr / {fm(totalValue(c))} total · AAV {fm(aav(c))} · {seasonLabel(yearsOf(c)[0].season)}–{seasonLabel(yearsOf(c)[yearsOf(c).length - 1].season)}
          </span>
          <span className="k">Type</span>
          <span>
            {c.type === 'ELC' ? 'Entry-level' : 'Standard'} · {c.twoWay ? 'two-way' : 'one-way'}
            {c.thirtyFivePlus ? ' · 35+ contract' : ''}
            {c.slid ? ` · slid ${c.slid}×` : ''}
            {c.source === 'estimated' ? <span className="muted"> · estimated terms</span> : c.source === 'real' ? ' · official terms' : ''}
          </span>
          {cl && (
            <>
              <span className="k">Clause</span>
              <span>
                {cl.kind === 'NMC' ? 'No-movement clause' : cl.kind === 'NTC' ? 'Full no-trade clause' : `Modified NTC (${cl.teams ?? '?'} teams, ${cl.mode === 'approve' ? 'approve list' : 'block list'})`} through {seasonLabel(cl.to)}
                {blocked.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Blocks: {blocked.map((id) => league.teams[id].abbr).join(', ')}</div>}
              </span>
            </>
          )}
          {c.next && (
            <>
              <span className="k">Extension</span>
              <span>
                {yearsOf(c.next).length} yr × {fm(fullCapHit(c.next))} from {seasonLabel(yearsOf(c.next)[0].season)}
              </span>
            </>
          )}
          <span className="k">At expiry</span>
          <span>{c.expiryStatus ?? (yearsOf(c.next ?? c).slice(-1)[0].season + 1 - p.birthYear >= 27 ? 'UFA' : 'RFA')}</span>
          {ws && (
            <>
              <span className="k">Waivers</span>
              <span className={ws.exempt ? 'good' : ''} title={ws.reason}>
                {ws.exempt ? 'Exempt' : 'Required'} <span className="muted" style={{ fontSize: 12 }}>— {ws.reason}</span>
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="muted">Not under contract.</div>
      )}
      <div className="kv">
        <span className="k">Free agency</span>
        <span>
          {fa.status === 'UFA' ? 'Unrestricted' : 'Restricted'} ({fa.group}) <span className="muted" style={{ fontSize: 12 }}>— {fa.reasons.join(' ')}</span>
        </span>
        <span className="k">Arbitration</span>
        <span className="muted" style={{ fontSize: 12 }}>{arb.reason}</span>
        <span className="k">NHL experience</span>
        <span>{nhlGames(p, league)} GP · {accruedSeasons(p)} accrued seasons</span>
        <span className="k">Market value</span>
        <span>
          {fm(value.value)}
          {value.comparables.length > 0 && <span className="muted" style={{ fontSize: 12 }}> — comparables: {value.comparables.slice(0, 3).map((x) => `${x.name} ${fm(x.aav)}`).join(', ')}</span>}
        </span>
      </div>
      {c && <YearTable c={c} season={season} title="Year-by-year" />}
      {c?.next && <YearTable c={c.next} season={season} title="Extension (signed)" />}
      {(p.contractHistory ?? []).length > 0 && (
        <div>
          <div className="muted" style={{ fontSize: 12, margin: '8px 0 4px' }}>Contract history</div>
          <div className="list" style={{ fontSize: 12 }}>
            {[...(p.contractHistory ?? [])].reverse().map((h, i) => (
              <div className="item" key={i} style={{ flexWrap: 'wrap' }}>
                <span className="dim" style={{ minWidth: 92 }}>
                  {seasonLabel(h.startSeason)}–{seasonLabel(h.endSeason)}
                </span>
                <span>{h.teamId !== null ? league.teams[h.teamId]?.abbr : 'FA'}</span>
                <span>
                  {h.years} yr / {fm(h.totalValue)} ({fm(h.aav)} AAV)
                </span>
                <span className="pill">{h.type === 'ELC' ? 'ELC' : ORIGIN[h.origin ?? 'signing'] ?? 'Contract'}</span>
                {h.source === 'estimated' && <span className="pill dim">est.</span>}
                {h.note && <span className="muted">{h.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

