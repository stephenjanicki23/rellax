import type { Column } from './common';
import type { League, Player } from '../../engine/types';
import { mutate, toast } from '../store';
import { centralRank, interviewProspect, isShortlisted, toggleShortlist } from '../../engine/economy/scouting';

const SHORT: Record<string, string> = { 'NA-S': 'NA', 'INT-S': 'INT', 'NA-G': 'NA G', 'INT-G': 'INT G' };

/** Shortlist star, Central Scouting rank and amateur club: shared by the Scouting and Draft pages. */
export function draftColumns(league: League): Column<Player>[] {
  return [
    {
      key: 'star',
      label: '★',
      render: (p) => (
        <button
          className={`star-toggle${isShortlisted(league, p) ? ' on' : ''}`}
          title={isShortlisted(league, p) ? 'Remove from your shortlist' : 'Add to your shortlist'}
          onClick={(e) => {
            e.stopPropagation();
            mutate((l) => toggleShortlist(l, l.players[p.id]));
          }}
        >
          {isShortlisted(league, p) ? '★' : '☆'}
        </button>
      ),
      sort: (p) => (isShortlisted(league, p) ? 1 : 0),
    },
    {
      key: 'cs',
      label: 'Central Scouting',
      render: (p) => {
        const r = centralRank(league, p);
        if (r) return <span title={`${r.stage === 'final' ? 'Final' : 'Midterm'} ranking`}>{SHORT[r.category]} #{r.rank}{r.stage === 'midterm' ? <span className="dim"> mid</span> : null}</span>;
        if (p.csRank) return <span className="muted" title={`Ranked on last year's ${p.csRank.category} list and went undrafted`}>'{String(league.season % 100).padStart(2, '0')} {SHORT[p.csRank.category]} #{p.csRank.rank} · re-entry</span>;
        return <span className="dim">—</span>;
      },
      sort: (p) => {
        const r = centralRank(league, p);
        return r ? -r.rank : p.csRank ? -500 - p.csRank.rank : -9999;
      },
    },
    {
      key: 'club',
      label: 'Club',
      render: (p) => <span className="muted">{p.amateurClub ? `${titleCase(p.amateurClub)} · ` : ''}{p.junior}</span>,
    },
  ];
}

/** Combine interview button (after the regular season). */
export function interviewColumn(league: League): Column<Player> {
  return {
    key: 'iv',
    label: '',
    render: (p) =>
      league.scouting.interviewed?.[p.id] === league.season ? (
        <span className="pill">interviewed</span>
      ) : (
        <button
          className="btn small"
          disabled={!league.draftCombineDone}
          title={league.draftCombineDone ? 'Sit down with him at the combine' : 'Interviews open at the draft combine (after the regular season)'}
          onClick={(e) => {
            e.stopPropagation();
            const r = mutate((l) => interviewProspect(l, l.players[p.id]));
            toast(r.message, r.ok ? 'info' : 'bad');
          }}
        >
          Interview
        </button>
      ),
  };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
