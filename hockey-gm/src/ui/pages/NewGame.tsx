import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONFIG } from '../../engine/data/leagueConfig';
import { newGame, loadGame, importGame, toast, ask } from '../store';
import { listSaves, deleteSave } from '../db';
import type { SaveMeta } from '../../engine/save';
import { TeamLogo } from '../components/common';
import { PHASE_LABEL, seasonLabel } from '../format';
import type { Phase } from '../../engine/types';

export function NewGame() {
  const [saves, setSaves] = useState<SaveMeta[]>([]);
  const [team, setTeam] = useState(0);
  const [seed, setSeed] = useState(() => `phl-${Math.floor(Math.random() * 1e9).toString(36)}`);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => void listSaves().then(setSaves).catch(() => setSaves([]));
  useEffect(refresh, []);
  const divisions = useMemo(() => DEFAULT_CONFIG.divisions, []);

  const start = () => {
    newGame({ seed, userTeamId: team });
  };

  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 20px 60px' }}>
      <div className="row" style={{ marginBottom: 22, gap: 14 }}>
        <svg width="46" height="46" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="14" fill="var(--panel)" stroke="var(--accent)" strokeWidth="2.5" />
          <ellipse cx="16" cy="19" rx="8" ry="3" fill="var(--accent)" />
        </svg>
        <div>
          <h1 style={{ fontSize: 26 }}>Hockey GM</h1>
          <div className="muted">
            Build a dynasty in the {DEFAULT_CONFIG.name}. 32 teams, 82 games, the {DEFAULT_CONFIG.championship} — and decades of history still to be written.
          </div>
        </div>
      </div>

      {saves.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-head">
            <h3>Continue</h3>
          </div>
          <div className="list">
            {saves.map((s) => (
              <div className="item" key={s.id} style={{ alignItems: 'center' }}>
                <b>{s.teamName}</b>
                <span className="muted">
                  {seasonLabel(s.season)} · {PHASE_LABEL[s.phase as Phase] ?? s.phase} · saved {new Date(s.savedAt).toLocaleString()}
                </span>
                <span style={{ marginLeft: 'auto' }} className="row">
                  <button className="btn primary small" onClick={() => void loadGame(s.id).catch((e) => toast(String(e), 'bad'))}>
                    Load
                  </button>
                  <button
                    className="btn danger small"
                    onClick={async () => {
                      if (await ask(`Delete the save "${s.teamName} ${seasonLabel(s.season)}"? This cannot be undone.`, 'Delete save')) void deleteSave(s.id).then(refresh);
                    }}
                  >
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>New career — choose your team</h3>
          <div className="right">
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                importGame(await f.text());
              } catch (err) {
                toast((err as Error).message, 'bad');
              }
            }} />
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              Import save file…
            </button>
          </div>
        </div>
        {divisions.map((d) => (
          <div key={d.id} style={{ marginBottom: 14 }}>
            <div className="muted" style={{ margin: '4px 0 6px', fontWeight: 600 }}>
              {d.name} Division
            </div>
            <div className="teamgrid">
              {DEFAULT_CONFIG.teams
                .map((t, i) => ({ t, i }))
                .filter(({ t }) => t.divisionId === d.id)
                .map(({ t, i }) => (
                  <button key={t.abbr} className={`teampick ${team === i ? 'on' : ''}`} onClick={() => setTeam(i)}>
                    <TeamLogo team={t} size={34} />
                    <div className="stack" style={{ gap: 0 }}>
                      <b>{t.city}</b>
                      <span className="muted">{t.name}</span>
                      <span className="dim" style={{ fontSize: 11 }}>
                        Market {'●'.repeat(t.marketSize)}
                        {'○'.repeat(5 - t.marketSize)}
                      </span>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        ))}
        <div className="row" style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <label className="field">
            League seed
            <input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} style={{ width: 220 }} />
          </label>
          <div className="muted" style={{ maxWidth: 420, fontSize: 12 }}>
            The seed fixes the generated universe and every simulated game. Share it to play the same league, or change it for a new one. Rosters
            are fictional; you will only see estimates of other teams' players until your scouts get a good look.
          </div>
          <button className="btn primary" style={{ marginLeft: 'auto', padding: '9px 18px' }} onClick={start}>
            Start career with {DEFAULT_CONFIG.teams[team].city} {DEFAULT_CONFIG.teams[team].name} →
          </button>
        </div>
      </div>
    </div>
  );
}
