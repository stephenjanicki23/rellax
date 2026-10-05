import { useMemo, useState } from 'react';
import type { Player, PromiseKind } from '../../engine/types';
import { useGame, mutate, toast } from '../store';
import { Bar, Card, Gauge, Modal, PlayerLink, Pos, Table, moraleLabel, type Column } from '../components/common';
import { playersOf } from '../../engine/league/helpers';
import { PERSONALITIES } from '../../engine/player/personality';
import {
  PROMISE_LABEL,
  actualRole,
  denyTradeRequest,
  expectedRole,
  holdMeeting,
  makePromise,
  meetingCooldown,
  promiseRefusal,
  roleLabel,
  topConcern,
} from '../../engine/league/room';
import { navigate } from '../router';

const PART_LABEL: Record<string, string> = { role: 'Role', winning: 'Winning', contract: 'Contract', promises: 'Promises', coach: 'Coach', room: 'Dressing room' };

/** The GM's view of the room: who's happy, who isn't and why, promises and trade requests. */
export function RoomPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const [meet, setMeet] = useState<number | null>(null);
  const roster = useMemo(() => playersOf(league, team.id), [league, version, team.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const requests = roster.filter((p) => p.tradeRequest);
  const open = roster.flatMap((p) => (p.promises ?? []).filter((x) => x.status === 'open').map((x) => ({ p, x })));
  const ml = moraleLabel(team.morale);
  const cols: Column<Player>[] = [
    { key: 'pos', label: 'Pos', render: (p) => <Pos pos={p.pos} /> },
    {
      key: 'name',
      label: 'Player',
      render: (p) => (
        <span>
          <PlayerLink p={p} /> {team.captain === p.id && <span className="pill accent">C</span>}
          {team.alternates.includes(p.id) && <span className="pill">A</span>}
          {p.tradeRequest && <span className={`pill ${p.tradeRequest.public ? 'bad' : 'warn'}`}>{p.tradeRequest.public ? 'Public trade request' : 'Wants a trade'}</span>}
        </span>
      ),
      sort: (p) => p.last,
      defaultDesc: false,
    },
    { key: 'pers', label: 'Personality', render: (p) => <span className="muted" title={PERSONALITIES[p.personality].description}>{PERSONALITIES[p.personality].label}</span> },
    {
      key: 'morale',
      label: 'Morale',
      render: (p) => (
        <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <span style={{ width: 60 }}>
            <Bar value={p.morale} max={100} color={p.morale >= 65 ? 'var(--good)' : p.morale >= 45 ? 'var(--warn)' : 'var(--bad)'} />
          </span>
          <span className={moraleLabel(p.morale).cls}>{moraleLabel(p.morale).text}</span>
        </span>
      ),
      sort: (p) => p.morale,
    },
    {
      key: 'role',
      label: 'Role (has / expects)',
      render: (p) => {
        const a = actualRole(league, p);
        const e = expectedRole(league, p);
        return (
          <span className={p.injury ? 'muted' : a > e ? 'txt-bad' : a < e ? 'txt-good' : ''}>
            {roleLabel(p, a, true)}
            {a !== e && !p.injury && <span className="muted"> / {roleLabel(p, e)}</span>}
          </span>
        );
      },
      sort: (p) => expectedRole(league, p) - actualRole(league, p),
    },
    { key: 'concern', label: 'Mood', render: (p) => <span className="muted">{topConcern(p)}</span> },
    { key: 'trust', label: 'Trust', num: true, render: (p) => Math.round(p.trust ?? 60), sort: (p) => p.trust ?? 60 },
    {
      key: 'act',
      label: '',
      render: (p) => (
        <button className="btn small" onClick={() => setMeet(p.id)}>
          Meet
        </button>
      ),
    },
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dressing Room</h1>
          <div className="sub">Roles, promises and morale. Players expect a role that matches where they rank on the team; you set it through the lines.</div>
        </div>
      </div>
      <div className="grid g3" style={{ marginBottom: 14 }}>
        <Card>
          <Gauge value={team.morale} label={`Team morale — ${ml.text}`} />
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Trade requests</span>
            <span className="v">{requests.length}</span>
            <span className="muted" style={{ fontSize: 12 }}>{requests.filter((p) => p.tradeRequest!.public).length} public</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="k">Open promises</span>
            <span className="v">{open.length}</span>
            <span className="muted" style={{ fontSize: 12 }}>{team.autoLines ? 'Auto lines: the coach honours your role and power-play promises' : 'Manual lines: keep them through your line-up'}</span>
          </div>
        </Card>
      </div>
      {requests.length > 0 && (
        <Card title="Trade requests">
          <div className="list">
            {requests.map((p) => (
              <div className="item" key={p.id} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <PlayerLink p={p} />
                <span className="muted" style={{ flex: 1, minWidth: 200 }}>
                  {p.tradeRequest!.reason}. {p.tradeRequest!.public ? 'It is public: the room knows.' : 'Private for now; it will go public if nothing changes.'}
                </span>
                <button className="btn small" onClick={() => setMeet(p.id)}>
                  Talk to him
                </button>
                <button className="btn small primary" onClick={() => navigate('trades')}>
                  Find a trade
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
      <div style={{ height: 14 }} />
      <Card tight>
        <Table rows={roster} columns={cols} rowKey={(p) => p.id} initialSort={{ key: 'morale', desc: false }} />
      </Card>
      {open.length > 0 && (
        <Card title="Promises you've made" className="">
          <div className="list">
            {open.map(({ p, x }, i) => (
              <div className="item" key={i}>
                <PlayerLink p={p} />
                <span>{PROMISE_LABEL[x.kind]}</span>
                <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                  {x.total ? `Honoured ${x.ok} of ${x.total} weeks · ` : ''}
                  {x.kind === 'role' || x.kind === 'pp' ? `needs 70% · ${Math.max(0, Math.ceil((x.dueDay - league.day) / 7))} weeks left` : 'until the end of the season'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {meet !== null && league.players[meet] && <MeetingModal p={league.players[meet]} onClose={() => setMeet(null)} />}
    </>
  );
}

function MeetingModal({ p, onClose }: { p: Player; onClose: () => void }) {
  const { league } = useGame();
  const [kind, setKind] = useState<PromiseKind>('role');
  const parts = p.moraleParts;
  const wait = meetingCooldown(league, p);
  const pers = PERSONALITIES[p.personality];
  const run = (fn: () => { ok: boolean; message: string }) => {
    const r = mutate(() => fn());
    toast(r.message, r.ok ? 'good' : 'bad');
    if (r.ok) onClose();
  };
  const refusal = promiseRefusal(league, p, kind);
  return (
    <Modal title={`Meeting: ${p.first} ${p.last}`} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="muted">
          {pers.label} — {pers.description} Morale <b>{Math.round(p.morale)}</b> · Trust in you <b>{Math.round(p.trust ?? 60)}</b>
        </div>
        <div className="muted">
          Role: <b>{roleLabel(p, actualRole(league, p), true)}</b> · expects <b>{roleLabel(p, expectedRole(league, p))}</b>
        </div>
        {parts && (
          <div className="stack" style={{ gap: 4 }}>
            {Object.entries(parts).map(([k, v]) => (
              <div key={k} className="row" style={{ gap: 8, fontSize: 12 }}>
                <span className="muted" style={{ width: 100 }}>
                  {PART_LABEL[k]}
                </span>
                <span style={{ flex: 1, position: 'relative', height: 8, background: 'var(--line)', borderRadius: 4 }}>
                  <span style={{ position: 'absolute', top: 0, bottom: 0, left: v >= 0 ? '50%' : `${50 + Math.max(-50, v * 2)}%`, width: `${Math.min(50, Math.abs(v) * 2)}%`, background: v >= 0 ? 'var(--good)' : 'var(--bad)', borderRadius: 4 }} />
                </span>
                <b className={v > 0.5 ? 'txt-good' : v < -0.5 ? 'txt-bad' : ''} style={{ width: 40, textAlign: 'right' }}>
                  {v > 0 ? '+' : ''}
                  {v.toFixed(0)}
                </b>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <button className="btn" disabled={wait > 0} title={wait ? `Available in ${wait} days` : 'Tell him he matters to the team'} onClick={() => run(() => holdMeeting(league, p, 'reassure'))}>
            Reassure him
          </button>
          <button className="btn" disabled={wait > 0} title={wait ? `Available in ${wait} days` : 'Push him to raise his game (competitors respond; sensitive players may not)'} onClick={() => run(() => holdMeeting(league, p, 'challenge'))}>
            Challenge him
          </button>
          {wait > 0 && <span className="dim" style={{ fontSize: 12 }}>Next meeting in {wait} days</span>}
        </div>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as PromiseKind)}>
            {(Object.keys(PROMISE_LABEL) as PromiseKind[]).map((k) => (
              <option key={k} value={k}>
                {PROMISE_LABEL[k]}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!!refusal} title={refusal ?? 'Kept promises build trust; broken ones cost it, and the room notices'} onClick={() => run(() => makePromise(league, p, kind))}>
            Make the promise
          </button>
          {refusal && <span className="dim" style={{ fontSize: 12 }}>{refusal}</span>}
        </div>
        {p.tradeRequest && (
          <div className="row">
            <span className="pill warn">He wants a trade: {p.tradeRequest.reason.toLowerCase()}</span>
            <button className="btn small danger" onClick={() => run(() => ({ ok: true, message: denyTradeRequest(league, p) }))}>
              Tell him he's staying
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
