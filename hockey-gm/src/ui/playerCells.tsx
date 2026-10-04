/** Reusable table columns for player lists (respecting scouting knowledge). */
import type { League, Player } from '../engine/types';
import type { Column } from './components/common';
import { PlayerLink, Pos, Stars, TeamLink, moraleLabel } from './components/common';
import { estimate } from '../engine/economy/scouting';
import { ARCHETYPES } from '../engine/player/archetypes';
import { fmtMoney } from '../engine/economy/contracts';
import { points, savePct, gaa, fmtToi, gsax } from '../engine/core/statline';
import { injuryLabel } from '../engine/player/injuries';
import { sv } from './format';
import { fitLabel, fitNorm, fitScore, playerSystemFit } from '../engine/team/fit';

type C = Column<Player>;

export function playerColumns(league: League, opts: { team?: boolean; stats?: boolean; contract?: boolean; potential?: boolean; morale?: boolean; status?: boolean; fit?: boolean } = {}): C[] {
  const st = (p: Player) => league.seasonStats[p.id]?.reg;
  const cols: C[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} />, sort: (p) => ['C', 'LW', 'RW', 'D', 'G'].indexOf(p.pos), defaultDesc: false },
    { key: 'name', label: 'Name', render: (p) => <PlayerLink p={p} />, sort: (p) => p.last, defaultDesc: false },
    { key: 'age', label: 'Age', num: true, render: (p) => league.season - p.birthYear, sort: (p) => league.season - p.birthYear, defaultDesc: false },
  ];
  if (opts.team) cols.push({ key: 'team', label: 'Team', render: (p) => <TeamLink league={league} id={p.teamId} short />, sort: (p) => (p.teamId === null ? 'ZZZ' : league.teams[p.teamId].abbr), defaultDesc: false });
  cols.push({ key: 'arch', label: 'Type', render: (p) => <span className="muted" title={ARCHETYPES[p.archetype].label}>{ARCHETYPES[p.archetype].short}</span>, sort: (p) => p.archetype, defaultDesc: false });
  cols.push({
    key: 'ca',
    label: 'Ability',
    render: (p) => {
      const e = estimate(league, p);
      return <Stars value={e.ca} range={e.exact ? undefined : [e.caLow, e.caHigh]} />;
    },
    sort: (p) => estimate(league, p).ca,
  });
  if (opts.potential !== false)
    cols.push({
      key: 'pa',
      label: 'Potential',
      render: (p) => {
        const e = estimate(league, p);
        return <Stars value={e.pa} range={e.exact ? undefined : [e.paLow, e.paHigh]} />;
      },
      sort: (p) => estimate(league, p).pa,
    });
  if (opts.fit) {
    // Fit to the user's team systems (offence, defence, forecheck).
    const mine = league.teams[league.userTeamId];
    const norm = fitNorm(league);
    const z = (p: Player) => (p.pos === 'G' ? null : playerSystemFit(norm, p, mine.tactics).overall);
    cols.push({
      key: 'fit',
      label: 'Fit',
      title: `Fit to ${mine.abbr}'s systems (${mine.tactics.offense} / ${mine.tactics.defense} / ${mine.tactics.forecheck})`,
      render: (p) => {
        const v = z(p);
        if (v === null) return <span className="dim">—</span>;
        const l = fitLabel(v);
        return <span className={`pill ${l.cls}`} title={`${l.text} (${fitScore(v)}/100) for ${mine.abbr}'s systems`}>{fitScore(v)}</span>;
      },
      sort: (p) => z(p) ?? -9,
    });
  }
  if (opts.status)
    cols.push({
      key: 'status',
      label: 'Status',
      render: (p) => (p.injury ? <span className="pill bad" title={injuryLabel(p.injury)}>INJ {p.injury.daysRemaining}d</span> : p.status === 'prospect' ? <span className="pill">Minors</span> : <span className="pill good">Active</span>),
      sort: (p) => (p.injury ? 2 : p.status === 'prospect' ? 1 : 0),
    });
  if (opts.morale)
    cols.push({
      key: 'morale',
      label: 'Morale',
      render: (p) => {
        const m = moraleLabel(p.morale);
        return <span className={m.cls}>{m.text}</span>;
      },
      sort: (p) => p.morale,
    });
  if (opts.contract)
    cols.push(
      { key: 'sal', label: 'Salary', num: true, render: (p) => (p.contract ? fmtMoney(p.contract.salary) : '—'), sort: (p) => p.contract?.salary ?? 0 },
      {
        key: 'yrs',
        label: 'Yrs',
        num: true,
        render: (p) => (p.contract ? `${p.contract.years}${p.contract.ntc ? ' NTC' : ''}${p.contract.type === 'ELC' ? ' ELC' : ''}${p.contract.next ? ' +ext' : ''}` : '—'),
        sort: (p) => p.contract?.years ?? 0,
      },
    );
  if (opts.stats) {
    cols.push(
      { key: 'gp', label: 'GP', num: true, render: (p) => st(p)?.gp ?? 0, sort: (p) => st(p)?.gp ?? 0 },
      {
        key: 'g',
        label: 'G / W',
        num: true,
        title: 'Goals (skaters) or wins (goalies)',
        render: (p) => (p.pos === 'G' ? (st(p)?.w ?? 0) : (st(p)?.g ?? 0)),
        sort: (p) => (p.pos === 'G' ? (st(p)?.w ?? 0) : (st(p)?.g ?? 0)),
      },
      {
        key: 'a',
        label: 'A / GAA',
        num: true,
        render: (p) => (p.pos === 'G' ? (st(p)?.gtoi ? gaa(st(p)!).toFixed(2) : '—') : (st(p)?.a1 ?? 0) + (st(p)?.a2 ?? 0)),
        sort: (p) => (p.pos === 'G' ? -(st(p)?.gtoi ? gaa(st(p)!) : 9) : (st(p)?.a1 ?? 0) + (st(p)?.a2 ?? 0)),
      },
      {
        key: 'p',
        label: 'P / SV%',
        num: true,
        render: (p) => (p.pos === 'G' ? sv(st(p) ? savePct(st(p)!) : 0) : <b>{st(p) ? points(st(p)!) : 0}</b>),
        sort: (p) => (p.pos === 'G' ? (st(p) ? savePct(st(p)!) : 0) : st(p) ? points(st(p)!) : 0),
      },
      {
        key: 'pm',
        label: '+/- / GSAx',
        num: true,
        render: (p) => (p.pos === 'G' ? (st(p) ? gsax(st(p)!).toFixed(1) : '—') : (st(p)?.pm ?? 0)),
        sort: (p) => (p.pos === 'G' ? (st(p) ? gsax(st(p)!) : 0) : (st(p)?.pm ?? 0)),
      },
      { key: 'toi', label: 'TOI', num: true, render: (p) => (st(p)?.gp && p.pos !== 'G' ? fmtToi(st(p)!.toi / st(p)!.gp) : '—'), sort: (p) => (st(p)?.gp ? st(p)!.toi / st(p)!.gp : 0) },
    );
  }
  return cols;
}
