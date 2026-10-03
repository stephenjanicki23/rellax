import { useState } from 'react';
import type { Player } from '../../engine/types';
import { Modal } from './common';
import { useGame } from '../store';
import { askingSalary, fmtMoney, marketValue } from '../../engine/economy/contracts';
import { offerUtility } from '../../engine/economy/freeAgency';

/**
 * Contract offer dialog used for re-signing, extensions and free agency.
 * `submit` returns the engine's response message.
 */
export function NegotiationModal({
  player,
  title,
  onClose,
  submit,
  freeAgent,
}: {
  player: Player;
  title: string;
  onClose: () => void;
  submit: (salary: number, years: number) => { ok: boolean; message: string };
  freeAgent?: boolean;
}) {
  const { league } = useGame();
  const [years, setYears] = useState(3);
  const ask = askingSalary(player, league, freeAgent ? null : player.teamId, years);
  const [salary, setSalary] = useState(ask);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const mv = marketValue(player, league);
  const interest = freeAgent ? offerUtility(league, player, { teamId: league.userTeamId, salary, years }) : null;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="kv">
          <span className="k">Market value</span>
          <span>{fmtMoney(mv)} / yr</span>
          <span className="k">Agent's ask ({years} yrs)</span>
          <span>{fmtMoney(ask)} / yr</span>
          {player.contract && (
            <>
              <span className="k">Current deal</span>
              <span>
                {fmtMoney(player.contract.salary)} · {player.contract.years} yr left
              </span>
            </>
          )}
        </div>
        <label className="field">
          Years: <b>{years}</b>
          <input type="range" min={1} max={8} value={years} onChange={(e) => setYears(Number(e.target.value))} />
        </label>
        <label className="field">
          Salary per season: <b>{fmtMoney(salary)}</b>
          <input
            type="range"
            min={league.cap.minSalary}
            max={Math.round(league.cap.upper * 0.2)}
            step={25}
            value={salary}
            onChange={(e) => setSalary(Number(e.target.value))}
          />
        </label>
        <div className="row">
          <button className="btn small" onClick={() => setSalary(Math.round(ask * 0.95 / 5) * 5)}>Ask −5%</button>
          <button className="btn small" onClick={() => setSalary(ask)}>Match ask</button>
          <button className="btn small" onClick={() => setSalary(Math.round(ask * 1.1 / 5) * 5)}>Ask +10%</button>
          {interest !== null && (
            <span className={interest >= 1.03 ? 'good' : interest >= 0.95 ? 'warn' : 'bad'} style={{ marginLeft: 'auto' }}>
              Interest: {interest >= 1.03 ? 'High' : interest >= 0.95 ? 'Moderate' : 'Low'}
            </span>
          )}
        </div>
        {msg && <div className={msg.ok ? 'good' : 'bad'}>{msg.message}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={() => {
              const r = submit(salary, years);
              setMsg(r);
              if (r.ok) setTimeout(onClose, 900);
            }}
          >
            Make offer
          </button>
        </div>
      </div>
    </Modal>
  );
}
