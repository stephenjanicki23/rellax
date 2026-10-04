/**
 * Player agents. Every player is represented by an agent from a (fictional)
 * agency, and the agent's style shapes contract talks: how high the opening
 * demand is, how long he keeps talking, how much he gives on each round and
 * whether he takes a lowball offer to the press.
 */
import { seedFrom } from '../core/rng';
import type { Agent, AgentStyle, League, Player } from '../types';

const AGENCIES = [
  'Northstar Sports Group', 'Blue Line Management', 'Crease & Co.', 'Overtime Athlete Partners', 'Faceoff Global',
  'Zamboni Street Sports', 'Top Shelf Representation', 'Iron Pond Agency', 'Hat Trick Management', 'Frozen Four Partners',
  'Red Line Sports', 'Glacier Athlete Group',
];
const FIRST = ['Allan', 'Brett', 'Claude', 'Darren', 'Elise', 'Frank', 'Gordie', 'Harlan', 'Ingrid', 'Jordan', 'Kirsten', 'Lars', 'Mitch', 'Nadia', 'Owen', 'Pierre', 'Quinn', 'Rhett', 'Sofia', 'Torrey', 'Ulf', 'Vic', 'Wes', 'Yvonne'];
const LAST = ['Ashford', 'Bellamy', 'Carrow', 'Delacroix', 'Ellison', 'Farrell', 'Gauthier', 'Hollis', 'Iverson', 'Jessup', 'Kowal', 'Lindqvist', 'Marchetti', 'Novak', 'Osterberg', 'Prentice', 'Quaid', 'Renfrew', 'Sandoval', 'Thorne', 'Ulrich', 'Vance', 'Whitlock', 'Yarrow'];

export const AGENT_STYLES: Record<AgentStyle, { label: string; blurb: string; demand: number; patience: number; concession: number }> = {
  hardball: { label: 'Hardball', blurb: 'Opens high, concedes little and walks away quickly.', demand: 1.06, patience: -14, concession: 0.1 },
  fair: { label: 'Straight shooter', blurb: 'Asks for market value and meets reasonable offers halfway.', demand: 1, patience: 0, concession: 0.2 },
  friendly: { label: 'Relationship builder', blurb: 'Patient and flexible — values a long-term relationship with the club.', demand: 0.97, patience: 14, concession: 0.28 },
  media: { label: 'Media savvy', blurb: 'Negotiates through the press: lowball offers end up in the news.', demand: 1.03, patience: -4, concession: 0.16 },
};

const STYLE_ORDER: AgentStyle[] = ['hardball', 'fair', 'friendly', 'media'];

function buildAgents(seed: string): Record<number, Agent> {
  const out: Record<number, Agent> = {};
  let id = 1;
  for (const [i, agency] of AGENCIES.entries()) {
    // Two or three agents per agency; the big agencies lean hardball.
    const n = i < 4 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const h = seedFrom(seed, 'agent', i, k);
      const style = i < 3 && k === 0 ? 'hardball' : STYLE_ORDER[h % STYLE_ORDER.length];
      out[id] = { id, name: `${FIRST[h % FIRST.length]} ${LAST[Math.floor(h / 32) % LAST.length]}`, agency, style, power: i < 4 };
      id++;
    }
  }
  return out;
}

/** Create the agent pool if the league doesn't have one (new leagues and older saves). */
export function ensureAgents(league: League): void {
  if (!league.agents || !Object.keys(league.agents).length) league.agents = buildAgents(league.seed);
}

/** The player's agent (assigned on first use; stars tend to sign with the power agencies). */
export function agentOf(league: League, p: Player): Agent {
  ensureAgents(league);
  const agents = league.agents!;
  if (p.agentId === undefined || !agents[p.agentId]) {
    const list = Object.values(agents);
    const power = list.filter((a) => a.power);
    const h = seedFrom(league.seed, 'client', p.id);
    const pool = p.ca >= 150 && h % 3 !== 0 ? power : list;
    p.agentId = pool[h % pool.length].id;
  }
  return agents[p.agentId];
}
