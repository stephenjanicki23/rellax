import { useState } from 'react';
import type { Player } from '../../engine/types';
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
  submit: (salary: number, years: number) => { ok: boolean; message: string };
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
  const [, bump] = useState(0);
  const mv = marketValue(player, league);
  const value = contractValue(player, league);
  const interest = freeAgent ? offerUtility(league, player, { teamId: me, salary, years }) : null;
  const neg = league.negotiations[player.id];
  const talks = neg && neg.season === league.season && neg.teamId === me && !freeAgent && !offerSheet ? neg : null;
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
          <span className="k">{talks ? 'His demand' : `Agent's ask (${years} yrs)`}</span>
          <span>{talks ? `${fmtMoney(talks.demand.aav)} × ${talks.demand.years} yrs` : `${fmtMoney(ask)} / yr`}</span>
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
        <div className="row">
          <button className="btn small" onClick={() => setSalary(Math.round((ask * 0.95) / 5) * 5)}>Ask −5%</button>
          <button className="btn small" onClick={() => setSalary(talks ? talks.demand.aav : ask)}>Match {talks ? 'demand' : 'ask'}</button>
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
              const res = submit(salary, years);
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
