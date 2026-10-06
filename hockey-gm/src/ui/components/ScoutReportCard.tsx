import type { League, Player } from '../../engine/types';
import { writtenReport } from '../../engine/economy/scoutReport';
import { roleForAbility } from '../../engine/player/ability';
import { estimate } from '../../engine/economy/scouting';
import { Bar, Card, PlayerLink, TeamLink } from './common';

const gradeColor = (pct: number) => (pct >= 78 ? 'var(--good)' : pct >= 40 ? 'var(--accent)' : pct >= 20 ? 'var(--warn)' : 'var(--bad)');

/** The written scouting report: area grades, concerns, NHL comparison and the scout's byline. */
export function ScoutReportCard({ league, p }: { league: League; p: Player }) {
  const r = writtenReport(league, p);
  const e = estimate(league, p);
  return (
    <Card
      title="Scouting report"
      right={
        <span className="muted" style={{ fontSize: 11 }}>
          {r.byline ? `${r.byline}${r.weeks ? ` · ${r.weeks} week${r.weeks === 1 ? '' : 's'} of viewings` : ''}` : 'League-wide book'} · {r.knowledge}% scouted
        </span>
      }
    >
      <div className="stack" style={{ gap: 8 }}>
        <span>{r.bottomLine}</span>
        {r.areas.map((a) => (
          <div key={a.label} className="stack" style={{ gap: 2 }}>
            <div className="row" style={{ gap: 8 }}>
              <b style={{ fontSize: 13, minWidth: 130 }}>{a.label}</b>
              <div style={{ flex: 1 }}>
                <Bar value={a.percentile} max={100} color={gradeColor(a.percentile)} />
              </div>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>{a.text}</span>
          </div>
        ))}
        {r.hiddenAreas > 0 && (
          <span className="dim" style={{ fontSize: 12 }}>
            {r.areas.length ? `${r.hiddenAreas} more area${r.hiddenAreas === 1 ? '' : 's'} need more viewings.` : 'Not enough viewings for a full report. Assign a scout to him.'}
          </span>
        )}
        {r.concerns.length > 0 && (
          <div className="stack" style={{ gap: 2 }}>
            <b className="txt-bad" style={{ fontSize: 13 }}>Concerns</b>
            {r.concerns.map((c) => (
              <span key={c} style={{ fontSize: 12 }}>• {c}</span>
            ))}
          </div>
        )}
        {r.comparison && (
          <span style={{ fontSize: 13 }}>
            <b>NHL comparison:</b>
            <PlayerLink p={r.comparison.player} /> <span className="dim">(<TeamLink league={league} id={r.comparison.player.teamId} short />)</span> <span className="muted">— {r.comparison.note}.</span>
          </span>
        )}
        <span className="dim" style={{ fontSize: 11 }}>
          Role today: {roleForAbility(p.pos, e.ca)}. {r.projecting ? 'Areas are graded on where they project, against current NHL players at his position.' : 'Areas are graded against current NHL players at his position.'}
        </span>
      </div>
    </Card>
  );
}
