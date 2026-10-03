/**
 * Console-style player card shared by the title-menu Rosters screen and
 * Franchise mode. Ratings come in through `rate`, so Franchise can pass
 * scouting estimates (with uncertainty ranges) instead of true values.
 */
import type { ReactNode } from 'react';
import type { AttrKey, Player, Team } from '../../engine/types';
import { ATTR_GROUPS, GOALIE_ATTR_GROUPS, GOALIE_ATTRS, MENTAL_ATTRS } from '../../engine/types';
import { ARCHETYPES } from '../../engine/player/archetypes';
import { PERSONALITIES, TRAITS } from '../../engine/player/personality';
import { countryLabel } from '../../engine/data/names';
import { Headshot, TeamLogo } from '../components/common';
import { attrLabel } from '../attrLabels';
import { heightLabel, weightLabel } from '../format';
import { Jersey } from './Jersey';
import { teamAccentVars } from '../teamColors';
import { playerOvr } from './exhibition';

export const ratingTier = (v: number): string => (v >= 85 ? 'elite' : v >= 75 ? 'good' : v >= 62 ? 'avg' : 'low');

export function potentialGrade(paValue: number, caValue: number, age: number): { grade: string; note: string } {
  const v = playerOvr(paValue);
  const grade = v >= 92 ? 'A+' : v >= 88 ? 'A' : v >= 84 ? 'A-' : v >= 80 ? 'B+' : v >= 76 ? 'B' : v >= 72 ? 'C+' : 'C';
  const note = age >= 28 ? 'At or near his peak' : paValue - caValue >= 20 ? 'Lots of room to grow' : paValue - caValue >= 8 ? 'Still improving' : 'Close to his ceiling';
  return { grade, note };
}

const FREE_AGENT = { abbr: 'FA', colors: ['#4a4f57', '#d7dbe0'] as [string, string] };

export interface PlayerCardViewProps {
  p: Player;
  team: Team | null;
  season: number;
  /** Rating on the 0–200 scale plus an uncertainty half-width (0 = exact). */
  rate: (k: AttrKey) => { value: number; range: number };
  ovr: string;
  potential: { grade: string; note: string };
  /** Show personality / traits (Franchise hides them until scouted). */
  personality?: string | null;
  traits?: string[] | null;
  footnote?: ReactNode;
}

export function PlayerCardView({ p, team, season, rate, ovr, potential, personality, traits, footnote }: PlayerCardViewProps) {
  const t = team ?? FREE_AGENT;
  const age = season - p.birthYear;
  const isG = p.pos === 'G';
  const groups = isG ? GOALIE_ATTR_GROUPS : ATTR_GROUPS;
  const arch = ARCHETYPES[p.archetype];
  const nat = countryLabel(p.nat);
  const keys = groups.flatMap((g) => g.keys).filter((k) => (isG || !(GOALIE_ATTRS as readonly string[]).includes(k)) && !(MENTAL_ATTRS as readonly string[]).includes(k));
  const ranked = [...keys].sort((a, b) => rate(b).value - rate(a).value);
  const pers = personality === undefined ? PERSONALITIES[p.personality].label : personality;
  const tr = traits === undefined ? p.traits.map((x) => TRAITS[x].label) : traits;
  return (
    <div className="mm-card" style={teamAccentVars(t.colors)}>
      <div className="mm-box mm-card-id">
        <Headshot
          p={p}
          size={220}
          color={t.colors[0]}
          fallback={
            <div className="mm-card-jersey">
              <Jersey primary={t.colors[0]} secondary={t.colors[1]} number={String(p.number)} abbr={t.abbr} />
            </div>
          }
        />
        <div className="mm-card-name">
          <span className="num">#{p.number}</span>
          <span className="first">{p.first}</span>
          <span className="last">{p.last}</span>
          <span className="meta">
            {p.pos} · {arch.label.replace('Goaltender ', 'Goalie ')}
          </span>
        </div>
        <div className="mm-card-badges">
          <div>
            <span>Overall</span>
            <b className="mm-ovr big">{ovr}</b>
          </div>
          <div>
            <span>Potential</span>
            <b className="mm-ovr big ghost">{potential.grade}</b>
          </div>
        </div>
        <div className="mm-card-note">{potential.note}</div>
        <dl className="mm-kv">
          <dt>Team</dt>
          <dd>
            {team ? (
              <>
                <TeamLogo team={team} size={18} /> {team.abbr}
              </>
            ) : (
              'Free agent'
            )}
          </dd>
          <dt>Age</dt>
          <dd>{age}</dd>
          <dt>Height</dt>
          <dd>{heightLabel(p.heightCm)}</dd>
          <dt>Weight</dt>
          <dd>{weightLabel(p.weightKg)}</dd>
          <dt>{isG ? 'Catches' : 'Shoots'}</dt>
          <dd>{p.shoots === 'L' ? 'Left' : 'Right'}</dd>
          <dt>Born</dt>
          <dd>{nat}</dd>
          <dt>Personality</dt>
          <dd>{pers ?? 'Unknown'}</dd>
          {tr && tr.length > 0 && (
            <>
              <dt>Traits</dt>
              <dd>{tr.join(', ')}</dd>
            </>
          )}
        </dl>
        <p className="mm-card-desc">{arch.description}</p>
        <div className="mm-card-tags">
          <div>
            <span>Strengths</span>
            {ranked.slice(0, 3).map((k) => (
              <em key={k}>{attrLabel(k)}</em>
            ))}
          </div>
          <div>
            <span>Weaknesses</span>
            {ranked.slice(-2).map((k) => (
              <em key={k} className="weak">
                {attrLabel(k)}
              </em>
            ))}
          </div>
        </div>
        {footnote && <div className="mm-card-note">{footnote}</div>}
      </div>
      <div className="mm-card-attrs">
        {groups.map((g) => (
          <div key={g.label} className="mm-box mm-attr-group">
            <h3>{g.label}</h3>
            {g.keys.map((k) => {
              const r = rate(k);
              const v = playerOvr(r.value);
              const half = Math.round(r.range * 0.42);
              return (
                <div key={k} className={`mm-attr ${ratingTier(v)}`}>
                  <span className="n">{attrLabel(k)}</span>
                  <span className="bar">
                    <i style={{ width: `${v}%` }} />
                  </span>
                  <b>{half > 0 ? `${Math.max(1, v - half)}-${Math.min(99, v + half)}` : v}</b>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
