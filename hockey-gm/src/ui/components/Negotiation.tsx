import { useState } from 'react';
import type { ClauseKind, Player } from '../../engine/types';
import type { OfferExtras } from '../../engine/economy/freeAgency';
import { agentOf, AGENT_STYLES } from '../../engine/cba/agents';
import { demandedClause, describeAsk, previewNegotiation, STANCE_LABEL } from '../../engine/cba/negotiation';
import { clauseStartSeason } from '../../engine/cba/contractService';

const CLAUSE_NAME: Record<ClauseKind, string> = { 'M-NTC': 'modified no-trade', NTC: 'no-trade clause', NMC: 'no-movement clause' };
import { Modal } from './common';
import { useGame } from '../store';
import { askingSalary, fmtMoney, marketValue } from '../../engine/economy/contracts';
import { offerUtility } from '../../engine/economy/freeAgency';
import { capSeason, contractFor, teamCapSheet } from '../../engine/cba/capManager';
import { seasonLabel } from '../format';
import { rulesFor } from '../../engine/cba/rules';
import { isOwnTeam } from '../../engine/cba/contractService';
import { calculateOfferSheetCompensation } from '../../engine/cba/rulesEngine';
import { contractValue } from '../../engine/cba/market';
import { OFFER_SHEET_DECISION_DAYS } from '../../engine/cba/rfa';

/**
 * Contract offer dialog used for re-signing, extensions, free agency and
 * RFA offer sheets. `submit` returns the engine's response message. Talks
 * with the player's own team show his demand and a patience meter.
 */
export function NegotiationModal({
  player,
  title,
  onClose,
  submit,
  freeAgent,
  offerSheet,
}: {
  player: Player;
  title: string;
  onClose: () => void;
  submit: (salary: number, years: number, extras: OfferExtras) => { ok: boolean; message: string };
  freeAgent?: boolean;
  offerSheet?: boolean;
}) {
  const { league } = useGame();
  const me = league.userTeamId;
  const season = capSeason(league);
  const r = rulesFor(season);
  const maxYears = isOwnTeam(player, me) ? r.maxTermOwnTeam : r.maxTermExternal;
  const [years, setYears] = useState(Math.min(3, maxYears));
  const ask = askingSalary(player, league, freeAgent || offerSheet ? null : player.teamId, years);
  const [salary, setSalary] = useState(ask);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [clause, setClause] = useState<ClauseKind | null>(null);
  const [bonusShare, setBonusShare] = useState(0);
  const agent = agentOf(league, player);
  const agentStyle = AGENT_STYLES[agent.style];
  const [, bump] = useState(0);
  const mv = marketValue(player, league);
  const value = contractValue(player, league);
  const interest = freeAgent ? offerUtility(league, player, { teamId: me, salary, years, clause }) : null;
  const ownTalks = !freeAgent && !offerSheet;
  // Own-team talks: the agent's real demand, shown from the start (before the first offer too).
  const talks = ownTalks ? previewNegotiation(league, player, me) : null;
  const stance = talks?.stance ?? null;
  const wantClause = talks ? (talks.demand.clause ?? null) : demandedClause(league, player, years);
  const canClause = clauseStartSeason(player, season + 1, years) !== null;
  // Extensions start next season, so judge them against next season's books.
  const extension = player.teamId === me && contractFor(player, season) !== null;
  const capYear = extension ? season + 1 : season;
  const space = teamCapSheet(league, me, capYear).space;
  const comp = offerSheet ? calculateOfferSheetCompensation(salary * years, years, season) : null;
  const patienceCls = talks ? (talks.patience > 60 ? 'good' : talks.patience > 30 ? 'warn' : 'bad') : '';
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="kv">
          <span className="k">Market value</span>
          <span>
            {fmtMoney(mv)} / yr
            {value.comparableMedian !== null && <span className="muted" style={{ fontSize: 12 }}> · comparables median {fmtMoney(value.comparableMedian)}</span>}
          </span>
          <span className="k">Agent</span>
          <span>
            {agent.name} <span className="muted">· {agent.agency}</span>
            <br />
            <span className="muted" style={{ fontSize: 12 }}>
              <b>{agentStyle.label}</b> — {agentStyle.blurb}
            </span>
          </span>
          {stance && (
            <>
              <span className="k">Stance</span>
              <span className={stance === 'open' ? 'good' : 'warn'}>{STANCE_LABEL[stance]}</span>
            </>
          )}
          <span className="k">{talks ? 'His demand' : `Agent's ask (${years} yrs)`}</span>
          <span>{talks ? describeAsk(talks.demand) : `${fmtMoney(ask)} / yr${wantClause ? ` + ${CLAUSE_NAME[wantClause]}` : ''}`}</span>
          {talks?.factors && talks.history.length === 0 && (
            <>
              <span className="k">How he got there</span>
              <span className="stack" style={{ gap: 1, fontSize: 12 }}>
                {talks.factors.map((f) => (
                  <span key={f.label}>
                    {f.label}
                    {f.pct !== 0 && <b className={f.pct < 0 ? 'good' : 'bad'}> {f.pct > 0 ? '+' : '−'}{Math.abs(Math.round(f.pct * 100))}%</b>}
                    {f.note && <span className="muted"> · {f.note}</span>}
                  </span>
                ))}
              </span>
            </>
          )}
          {player.contract && (
            <>
              <span className="k">Current deal</span>
              <span>
                {fmtMoney(player.contract.salary)} · {player.contract.years} yr left
              </span>
            </>
          )}
          <span className="k">Cap space {seasonLabel(capYear)} after</span>
          <span className={space - salary < 0 ? 'bad' : ''}>{fmtMoney(space - salary)}</span>
        </div>
        {talks && (
          <div>
            <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12 }}>
              <span>Patience</span>
              <b className={patienceCls}>{talks.patience <= 0 ? 'Talks ended' : `${talks.patience}%`}</b>
            </div>
            <div className="bar" style={{ height: 8 }}>
              <i style={{ width: `${Math.max(0, talks.patience)}%`, background: `var(--${patienceCls || 'accent'})` }} />
            </div>
            {talks.history.length > 0 && (
              <div className="list" style={{ fontSize: 12, marginTop: 6, maxHeight: 110, overflow: 'auto' }}>
                {[...talks.history].reverse().map((h, i) => (
                  <div className="item" key={i}>
                    <span className="dim" style={{ minWidth: 92 }}>
                      {fmtMoney(h.aav)} × {h.years}
                    </span>
                    <span>{h.response}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="field">
          Years: <b>{years}</b> <span className="muted" style={{ fontSize: 12 }}>(max {maxYears} — {isOwnTeam(player, me) ? 'own player' : 'other team'})</span>
          <input type="range" min={1} max={maxYears} value={years} onChange={(e) => setYears(Number(e.target.value))} />
        </label>
        <label className="field">
          Salary per season: <b>{fmtMoney(salary)}</b>
          <input type="range" min={r.minimumSalary} max={Math.round(r.maxSalary)} step={25} value={salary} onChange={(e) => setSalary(Number(e.target.value))} />
        </label>
        {!offerSheet && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              Trade protection
              <select value={clause ?? ''} disabled={!canClause} onChange={(e) => setClause((e.target.value || null) as ClauseKind | null)}>
                <option value="">None</option>
                <option value="M-NTC">Modified no-trade (10-team list)</option>
                <option value="NTC">Full no-trade</option>
                <option value="NMC">No-movement</option>
              </select>
              {!canClause && <span className="muted" style={{ fontSize: 11 }}>Not UFA-eligible during this term — clauses not allowed.</span>}
            </label>
            {ownTalks && (
              <label className="field" style={{ flex: 1, minWidth: 180 }}>
                Signing bonus: <b>{Math.round(bonusShare * 100)}%</b> of pay
                <input type="range" min={0} max={0.8} step={0.1} value={bonusShare} onChange={(e) => setBonusShare(Number(e.target.value))} />
              </label>
            )}
          </div>
        )}
        <div className="row">
          <button className="btn small" onClick={() => setSalary(Math.round((ask * 0.95) / 5) * 5)}>Ask −5%</button>
          <button
            className="btn small"
            onClick={() => {
              setSalary(talks ? talks.demand.aav : ask);
              if (talks) {
                setYears(talks.demand.years);
                setClause(canClause ? (talks.demand.clause ?? null) : null);
                setBonusShare(talks.demand.bonusShare ?? 0);
              } else if (wantClause && canClause) setClause(wantClause);
            }}
          >
            Match {talks ? 'demand' : 'ask'}
          </button>
          <button className="btn small" onClick={() => setSalary(Math.round((ask * 1.1) / 5) * 5)}>Ask +10%</button>
          {interest !== null && (
            <span className={interest >= 1.03 ? 'good' : interest >= 0.95 ? 'warn' : 'bad'} style={{ marginLeft: 'auto' }}>
              Interest: {interest >= 1.03 ? 'High' : interest >= 0.95 ? 'Moderate' : 'Low'}
            </span>
          )}
        </div>
        {comp && (
          <div className="muted" style={{ fontSize: 12 }}>
            Offer-sheet compensation (AAV for compensation {fmtMoney(comp.compAav)}): <b>{comp.description}</b>. The rights team has {OFFER_SHEET_DECISION_DAYS} days to match or take the picks.
          </div>
        )}
        {msg && <div className={msg.ok ? 'good' : 'bad'}>{msg.message}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            disabled={!!talks && talks.patience <= 0}
            onClick={() => {
              const res = submit(salary, years, { clause: canClause ? clause : null, bonusShare: ownTalks ? bonusShare : 0 });
              setMsg(res);
              bump((x) => x + 1);
              if (res.ok) setTimeout(onClose, 900);
            }}
          >
            {offerSheet ? 'Submit offer sheet' : 'Make offer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
