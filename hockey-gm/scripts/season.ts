import { createLeague } from '../src/engine/league/create';
import { simTo } from '../src/engine/league/season';
import { simOffseason } from '../src/engine/league/offseason';
import { points } from '../src/engine/core/statline';
const league = createLeague({ seed: process.argv[2] ?? 'season-test' });
league.settings.autoManageUser = true;
const seasons = Number(process.argv[3] ?? 1);
for (let s = 0; s < seasons; s++) {
  const t0 = Date.now();
  simTo(league, 'endSeason');
  const h = league.history[league.history.length - 1];
  const rows = h.standings;
  const top = Object.values(league.players).map((p) => ({ p, s: p.career.find((c) => c.season === h.season && !c.playoffs)?.stats })).filter((x) => x.s).sort((a, b) => points(b.s!) - points(a.s!)).slice(0, 5);
  console.log(`Season ${h.season}: ${Date.now() - t0}ms champ=${league.teams[h.champion!].abbr} best=${league.teams[rows[0].teamId].abbr} ${rows[0].pts}pts worst=${league.teams[rows[rows.length - 1].teamId].abbr} ${rows[rows.length - 1].pts}pts`);
  console.log('  top scorers:', top.map((x) => `${x.p.last} ${x.s!.g}+${x.s!.a1 + x.s!.a2}=${points(x.s!)}`).join(', '));
  console.log('  awards:', h.awards.map((a) => `${a.award.split(' (')[0]}: ${a.playerId ? league.players[a.playerId]?.last : a.coachId ? league.coaches[a.coachId].last : league.teams[a.teamId].abbr}`).join('; '));
  const t1 = Date.now();
  simOffseason(league);
  const fa = Object.values(league.players).filter((p) => p.status === 'fa').length;
  const act = Object.values(league.players).filter((p) => p.status === 'active').length;
  const avgCA = Object.values(league.players).filter((p) => p.status === 'active').reduce((s, p) => s + p.ca, 0) / act;
  console.log(`  offseason ${Date.now() - t1}ms active=${act} fa=${fa} avgCA=${avgCA.toFixed(1)} players=${Object.keys(league.players).length} news=${league.news.length} tx=${league.transactions.length}`);
}
