import type { Coach, CoachRatings, League } from '../../engine/types';
import { coachTotals, coachTraits } from '../../engine/team/coaching';
import { attr20 } from '../../engine/player/ability';
import { href } from '../router';
import { Bar, attrColor } from './common';

export function CoachLink({ c, full = true }: { c: Coach | undefined; full?: boolean }) {
  if (!c) return <span className="dim">—</span>;
  return <a href={href(`coach/${c.id}`)}>{full ? `${c.first} ${c.last}` : `${c.first[0]}. ${c.last}`}</a>;
}

/** "512-301-88" style record (ties shown when there are any). */
export function recordText(r: { w: number; l: number; t?: number; otl: number }): string {
  return r.t ? `${r.w}-${r.l}-${r.t}-${r.otl}` : `${r.w}-${r.l}-${r.otl}`;
}

export function careerRecord(c: Coach): string {
  const t = coachTotals(c);
  return t.gp ? recordText(t) : '—';
}

export function coachAge(league: League, c: Coach): string {
  return c.birthKnown === false ? '—' : String(league.season - c.birthYear);
}

export function TraitChips({ c, max = 4 }: { c: Coach; max?: number }) {
  const { strengths, weaknesses } = coachTraits(c);
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {strengths.slice(0, max).map((t) => (
        <span key={`s${t.key}`} className="pill good" title={t.detail}>
          ▲ {t.label}
        </span>
      ))}
      {weaknesses.slice(0, Math.max(1, max - 2)).map((t) => (
        <span key={`w${t.key}`} className="pill bad" title={t.detail}>
          ▼ {t.label}
        </span>
      ))}
    </span>
  );
}

export const RATING_LABEL: Record<keyof CoachRatings, string> = {
  offense: 'Offence',
  defense: 'Defence',
  tactics: 'Tactics',
  motivation: 'Motivation',
  development: 'Development',
  specialTeams: 'Special teams',
  discipline: 'Discipline',
  goaltending: 'Goaltending',
};

const ROLE_ORDER: Record<Coach['role'], (keyof CoachRatings)[]> = {
  head: ['tactics', 'offense', 'defense', 'motivation', 'specialTeams', 'discipline', 'development', 'goaltending'],
  assistant: ['offense', 'defense', 'specialTeams', 'development', 'tactics', 'motivation', 'discipline', 'goaltending'],
  goalie: ['goaltending', 'development', 'motivation', 'tactics'],
};

export function CoachRatingBars({ c }: { c: Coach }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      {ROLE_ORDER[c.role].map((k) => {
        const v = attr20(c.ratings[k]);
        return (
          <div key={k} className="row" style={{ gap: 8, fontSize: 12 }}>
            <span style={{ width: 92 }} className="muted">
              {RATING_LABEL[k]}
            </span>
            <span style={{ flex: 1 }}>
              <Bar value={c.ratings[k]} color={attrColor(v)} />
            </span>
            <b style={{ width: 20, textAlign: 'right', color: attrColor(v) }}>{v}</b>
          </div>
        );
      })}
    </div>
  );
}
