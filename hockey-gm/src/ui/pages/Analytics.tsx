import { useMemo, useRef, useState } from 'react';
import { useGame } from '../store';
import { Card, BarChart, Seg } from '../components/common';
import { runGameBatchAsync, seasonSummary, checkTargets, GAME_TARGETS, SEASON_TARGETS, type BatchSummary } from '../../engine/analytics';
import { TUNING } from '../../engine/sim/engine';
import { seasonLabel } from '../format';

function TargetTable({ rows }: { rows: ReturnType<typeof checkTargets> }) {
  const fmt = (v: number) => (Math.abs(v) < 1 && v !== 0 ? v.toFixed(3) : v.toFixed(2));
  return (
    <table className="tbl">
      <thead>
        <tr><th></th><th>Metric</th><th className="num">Value</th><th className="num">Realistic range</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className={r.ok ? 'good' : 'bad'}>{r.ok ? '✓' : '✗'}</td>
            <td>{r.label}</td>
            <td className="num"><b>{fmt(r.value)}</b></td>
            <td className="num muted">{fmt(r.lo)} – {fmt(r.hi)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AnalyticsPage() {
  const { league, version } = useGame();
  const [n, setN] = useState<'100' | '1000' | '10000'>('1000');
  const [batch, setBatch] = useState<BatchSummary | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const cancel = useRef(false);
  const [salt, setSalt] = useState(0);
  const seasons = [league.season, ...league.history.map((h) => h.season).reverse().filter((s) => s !== league.season)];
  const [season, setSeason] = useState(league.history.length ? league.history[league.history.length - 1].season : league.season);
  const summary = useMemo(() => seasonSummary(league, season), [league, version, season]);

  const run = async () => {
    cancel.current = false;
    setProgress(0);
    const total = Number(n);
    const res = await runGameBatchAsync(league, total, (d) => setProgress(d / total), salt, () => cancel.current);
    setBatch(res);
    setProgress(null);
    setSalt((s) => s + 1);
  };
  return (
    <>
      <div className="page-head">
        <h1>League Simulation Analytics</h1>
        <span className="sub">Developer tool: simulate batches with the current rosters (league state is not changed) and compare distributions to realistic ranges.</span>
      </div>
      <div className="grid g-main">
        <div className="grid">
          <Card
            title="Game engine batch"
            right={
              <div className="row">
                <Seg value={n} onChange={setN} options={[{ id: '100', label: '100' }, { id: '1000', label: '1,000' }, { id: '10000', label: '10,000' }]} />
                {progress === null ? (
                  <button className="btn primary" onClick={() => void run()}>Run games</button>
                ) : (
                  <button className="btn" onClick={() => (cancel.current = true)}>Stop ({Math.round(progress * 100)}%)</button>
                )}
              </div>
            }
          >
            {progress !== null && <div className="bar" style={{ marginBottom: 10 }}><i style={{ width: `${progress * 100}%` }} /></div>}
            {batch ? (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>
                  {batch.games.toLocaleString()} games in {(batch.ms / 1000).toFixed(1)} s ({(batch.ms / batch.games).toFixed(2)} ms/game) · fights/game {batch.fightsPerGame.toFixed(2)} · SH goals/team {batch.shGoalsPerTeam.toFixed(2)} · TK {batch.takeawaysPerTeam.toFixed(1)} · GV {batch.giveawaysPerTeam.toFixed(1)}
                </div>
                <TargetTable rows={checkTargets(batch as unknown as Record<string, number>, GAME_TARGETS)} />
              </>
            ) : (
              <div className="empty">Run a batch to see the distributions.</div>
            )}
          </Card>
          {batch && (
            <div className="grid g2">
              <Card title="Total goals per game">
                <BarChart data={batch.totalGoalsHist.map((h) => ({ label: String(h.bin), value: h.count / batch.games }))} valueFmt={(v) => `${(v * 100).toFixed(1)}%`} />
              </Card>
              <Card title="Final margin">
                <BarChart data={batch.marginHist.map((h) => ({ label: h.label, value: h.count / batch.games }))} color="var(--purple)" valueFmt={(v) => `${(v * 100).toFixed(1)}%`} />
              </Card>
              <Card title="Shots on goal per team-game">
                <BarChart data={batch.shotsHist.map((h) => ({ label: String(h.bin), value: h.count }))} labelEvery={5} color="var(--good)" />
              </Card>
            </div>
          )}
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Season distributions" right={<select value={season} onChange={(e) => setSeason(Number(e.target.value))}>{seasons.map((s) => <option key={s} value={s}>{seasonLabel(s)}{s === league.season && !league.history.some((h) => h.season === s) ? ' (in progress)' : ''}</option>)}</select>}>
            <TargetTable rows={checkTargets(summary as unknown as Record<string, number>, SEASON_TARGETS)} />
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Injuries/team {summary.injuriesPerTeam.toFixed(1)} · shutouts {summary.shutoutsTotal} · starter GAA {summary.starterGaaMean.toFixed(2)} · top-400 ability {summary.top400CA.toFixed(1)}
            </div>
          </Card>
          <Card title="Skater points (40+ GP)">
            <BarChart data={summary.skaterPointsHist.map((h) => ({ label: String(h.bin), value: h.count }))} labelEvery={2} />
          </Card>
          <Card title="Starting goalie save %">
            <BarChart
              data={[0.88, 0.89, 0.9, 0.905, 0.91, 0.915, 0.92, 0.93].map((lo, i, a) => ({ label: lo.toFixed(3).replace(/^0/, ''), value: summary.starterSvPcts.filter((v) => v >= lo && v < (a[i + 1] ?? 1)).length }))}
              color="var(--warn)"
            />
          </Card>
          <Card title="Engine tuning (read-only)">
            <div className="kv mono" style={{ fontSize: 12 }}>
              {Object.entries(TUNING).map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <span className="k">{k}</span>
                  <span>{typeof v === 'number' ? Number(v.toPrecision(4)) : String(v)}</span>
                </span>
              ))}
              <span className="k">ratingBaseline</span>
              <span>{league.ratingBaseline.toFixed(2)}</span>
              <span className="k">seed</span>
              <span>{league.seed}</span>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
