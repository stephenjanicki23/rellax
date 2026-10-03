import { useRef } from 'react';
import { useGame, mutate, saveNow, exportGame, importGame, quitToMenu, toast } from '../store';
import { Card } from '../components/common';

export function SettingsPage() {
  const { league } = useGame();
  const fileRef = useRef<HTMLInputElement>(null);
  const s = league.settings;
  return (
    <>
      <div className="page-head">
        <h1>Save & Settings</h1>
      </div>
      <div className="grid g2">
        <Card title="Save game">
          <div className="stack">
            <span className="muted">The game autosaves to your browser (IndexedDB) after every action. Export a file to back up or move a career between devices.</span>
            <div className="row">
              <button className="btn primary" onClick={() => void saveNow().then(() => toast('Saved', 'good'))}>Save now</button>
              <button className="btn" onClick={exportGame}>Export save file</button>
              <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  importGame(await f.text());
                  toast('Save imported', 'good');
                } catch (err) {
                  toast((err as Error).message, 'bad');
                }
              }} />
              <button className="btn" onClick={() => fileRef.current?.click()}>Import save file</button>
              <button className="btn danger" onClick={quitToMenu}>Quit to main menu</button>
            </div>
            <span className="dim" style={{ fontSize: 12 }}>League seed: <span className="mono">{league.seed}</span></span>
          </div>
        </Card>
        <Card title="Gameplay">
          <div className="stack">
            <label className="row">
              <input type="checkbox" checked={s.godMode} onChange={(e) => mutate((l) => (l.settings.godMode = e.target.checked))} />
              <span>
                <b>Perfect information</b> <span className="muted">— show true ability and potential for every player (disables scouting uncertainty)</span>
              </span>
            </label>
            <label className="row">
              <input type="checkbox" checked={s.autoManageUser} onChange={(e) => mutate((l) => (l.settings.autoManageUser = e.target.checked))} />
              <span>
                <b>Assistant GM mode</b> <span className="muted">— let the AI handle your drafts, signings, call-ups and contracts</span>
              </span>
            </label>
            <label className="field">
              Injury frequency multiplier: <b>{s.injuryRate.toFixed(2)}×</b>
              <input type="range" min={0.25} max={2} step={0.05} value={s.injuryRate} onChange={(e) => mutate((l) => (l.settings.injuryRate = Number(e.target.value)))} />
            </label>
            <label className="field">
              Trade difficulty: <b>{s.tradeDifficulty.toFixed(2)}×</b>
              <input type="range" min={0.6} max={1.6} step={0.05} value={s.tradeDifficulty} onChange={(e) => mutate((l) => (l.settings.tradeDifficulty = Number(e.target.value)))} />
            </label>
          </div>
        </Card>
        <Card title="About the simulation">
          <div className="stack muted" style={{ fontSize: 12 }}>
            <span>Every game is simulated possession by possession — faceoffs, breakouts, zone entries, cycles, shots with an expected-goals model, saves, rebounds, penalties, line changes, fatigue and momentum. Results are deterministic for a given seed.</span>
            <span>Balance is checked continuously against realistic distributions on the Sim Analytics page and in the automated validation suite.</span>
          </div>
        </Card>
      </div>
    </>
  );
}
