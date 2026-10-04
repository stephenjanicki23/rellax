import { useMemo, useState } from 'react';
import type { Coach } from '../../engine/types';
import { useGame, mutate, toast, ask } from '../store';
import { Card, Modal, Table, Tabs, type Column } from '../components/common';
import { CoachLink, CoachRatingBars, TraitChips, careerRecord, coachAge, recordText } from '../components/CoachBits';
import { coachOverall, coachTotals, PHILOSOPHY_LABEL } from '../../engine/team/coaching';
import { attr20 } from '../../engine/player/ability';
import { fmtMoney } from '../../engine/economy/contracts';
import {
  ROLE_LABEL,
  ROLE_SLOT,
  candidatesFor,
  coachAsk,
  coachOf,
  coachRefusal,
  deadStaffMoney,
  extendCoach,
  extensionAsk,
  offerCoach,
  staffBudget,
  staffSpend,
  userFireCoach,
  type StaffSlot,
} from '../../engine/team/staffMarket';
import { seasonLabel } from '../format';

type Role = Coach['role'];
interface Deal {
  c: Coach;
  role: Role;
  kind: 'hire' | 'extend';
}

/** The GM's coaching staff: who is behind the bench, what they're good at, and the coaching market. */
export function CoachingPage() {
  const { league, version } = useGame();
  const team = league.teams[league.userTeamId];
  const [role, setRole] = useState<Role>('head');
  const [deal, setDeal] = useState<Deal | null>(null);
  const candidates = useMemo(() => candidatesFor(league, team.id, role), [league, version, team.id, role]); // eslint-disable-line react-hooks/exhaustive-deps
  const budget = staffBudget(team);
  const spend = staffSpend(league, team);
  const dead = deadStaffMoney(league, team);

  const fire = async (slot: StaffSlot) => {
    const c = coachOf(league, team, slot)!;
    const owed = c.contract && !c.interim ? c.contract.salary * c.contract.years : 0;
    const extra = slot === 'headCoach' ? ' Your assistant will take over on an interim basis until you hire a replacement.' : '';
    if (!(await ask(`Fire ${c.first} ${c.last}?${owed ? ` The club still owes him ${fmtMoney(owed)} (${fmtMoney(c.contract!.salary)} a season for ${c.contract!.years} more season${c.contract!.years > 1 ? 's' : ''}), which stays on the staff budget.` : ''}${extra}`, 'Fire'))) return;
    const r = mutate((l) => userFireCoach(l, l.userTeamId, slot));
    toast(r.message, r.ok ? 'info' : 'bad');
  };

  const cols: Column<Coach>[] = [
    {
      key: 'name',
      label: 'Coach',
      render: (c) => (
        <span className="stack" style={{ gap: 2 }}>
          <span>
            <CoachLink c={c} /> {c.real && <span className="pill" title="Real NHL head coach: his record comes from the NHL feed">NHL</span>}
          </span>
          <span className="dim" style={{ fontSize: 11 }}>
            {c.teamId !== null ? `${ROLE_LABEL[c.role]}, ${league.teams[c.teamId].abbr}` : c.background ?? ''}
          </span>
        </span>
      ),
      sort: (c) => c.last,
      defaultDesc: false,
    },
    { key: 'age', label: 'Age', num: true, render: (c) => coachAge(league, c), sort: (c) => (c.birthKnown === false ? 0 : league.season - c.birthYear) },
    { key: 'ph', label: 'Style', render: (c) => <span className="muted" title={c.styleNote ?? ''}>{PHILOSOPHY_LABEL[c.philosophy]}</span> },
    { key: 'ovr', label: 'Ovr', num: true, render: (c) => <b>{attr20(coachOverall({ ...c, role }))}</b>, sort: (c) => coachOverall({ ...c, role }) },
    { key: 'traits', label: 'Strengths / weaknesses', render: (c) => <TraitChips c={c} max={3} /> },
    {
      key: 'rec',
      label: 'NHL record',
      num: true,
      render: (c) => {
        const t = coachTotals(c);
        return t.gp ? (
          <span title={`${t.gp} GP · ${(t.ptsPct * 100).toFixed(1)} pts% · playoffs ${t.pw}-${t.pl}`}>
            {recordText(t)}
            {t.cups ? <span className="pill accent">{t.cups}× Cup</span> : null}
          </span>
        ) : (
          <span className="dim">—</span>
        );
      },
      sort: (c) => coachTotals(c).w,
    },
    { key: 'rep', label: 'Rep', num: true, render: (c) => c.reputation, sort: (c) => c.reputation },
    {
      key: 'ask',
      label: 'Asking',
      num: true,
      render: (c) => {
        const a = coachAsk(league, c, role, team.id);
        return `${fmtMoney(a.salary)} × ${a.years}`;
      },
      sort: (c) => coachAsk(league, c, role, team.id).salary,
    },
    {
      key: 'act',
      label: '',
      render: (c) => {
        const no = coachRefusal(league, c, team.id, role);
        return (
          <button className="btn small primary" disabled={!!no} title={no ?? 'Make him an offer'} onClick={() => setDeal({ c, role, kind: 'hire' })}>
            Offer
          </button>
        );
      },
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Coaching Staff</h1>
          <div className="sub">You hire and fire the coaches. They set the lines' systems and tactics, develop the players and run the bench.</div>
        </div>
      </div>
      <Card>
        <div className="row" style={{ gap: 18 }}>
          <span>
            <span className="muted">Staff budget </span>
            <b>{fmtMoney(spend)}</b> <span className="muted">of {fmtMoney(budget)}</span>
          </span>
          <span style={{ flex: 1, minWidth: 160 }}>
            <div className="bar" style={{ height: 8 }}>
              <i style={{ width: `${Math.min(100, (spend / budget) * 100)}%`, background: spend > budget ? 'var(--bad)' : undefined }} />
            </div>
          </span>
          <span className="muted">Room {fmtMoney(Math.max(0, budget - spend))}</span>
          {dead > 0 && (
            <span className="pill warn" title={(team.deadStaff ?? []).map((d) => `${d.name}: ${fmtMoney(d.salary)} through ${seasonLabel(d.throughSeason)}`).join('\n')}>
              Paying fired coaches {fmtMoney(dead)}
            </span>
          )}
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>Coaches are paid outside the salary cap, from the owner's staff budget. Fired coaches are paid the rest of their contracts.</div>
      </Card>

      <div className="grid g3" style={{ margin: '14px 0' }}>
        {(['headCoach', 'assistant', 'goalieCoach'] as StaffSlot[]).map((slot) => {
          const c = coachOf(league, team, slot);
          const r = slot === 'headCoach' ? ('head' as Role) : slot === 'assistant' ? ('assistant' as Role) : ('goalie' as Role);
          return (
            <Card key={slot} title={<h3>{ROLE_LABEL[r]}</h3>} right={c?.interim ? <span className="pill warn">Interim</span> : null}>
              {c ? (
                <StaffCard
                  c={c}
                  onFire={() => fire(slot)}
                  onExtend={() => setDeal({ c, role: r, kind: 'extend' })}
                  canExtend={!!c.contract && (c.interim || c.contract.years <= 1)}
                />
              ) : (
                <div className="stack">
                  <span className="muted">Vacant. {slot === 'headCoach' ? 'Your team needs a head coach before its next game.' : 'Hire one from the market below.'}</span>
                  <button className="btn small" onClick={() => setRole(r)}>
                    Browse candidates
                  </button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card title={<h3>Coaching market</h3>} right={<span className="muted" style={{ fontSize: 12 }}>Unemployed coaches, plus other clubs' assistants who can interview for a head job</span>} tight>
        <Tabs
          value={role}
          onChange={setRole}
          tabs={[
            { id: 'head', label: 'Head coaches' },
            { id: 'assistant', label: 'Assistants' },
            { id: 'goalie', label: 'Goaltending coaches' },
          ]}
        />
        <Table rows={candidates} columns={cols} rowKey={(c) => c.id} initialSort={{ key: 'ovr' }} empty="No candidates right now." />
      </Card>
      {deal && <DealModal deal={deal} onClose={() => setDeal(null)} />}
    </>
  );
}

function StaffCard({ c, onFire, onExtend, canExtend }: { c: Coach; onFire: () => void; onExtend: () => void; canExtend: boolean }) {
  const { league } = useGame();
  const stint = (c.stints ?? []).filter((s) => s.season === league.season && s.teamId === c.teamId);
  const tenure = c.career.filter((l) => l.teamId === c.teamId && (l.role ?? 'head') === 'head' && l.season >= (c.hiredSeason ?? 0));
  const tw = [...tenure, ...stint].reduce((a, x) => ({ w: a.w + x.w, l: a.l + x.l, otl: a.otl + x.otl }), { w: 0, l: 0, otl: 0 });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          <CoachLink c={c} />
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {PHILOSOPHY_LABEL[c.philosophy]}
          {c.styleNote ? ` — ${c.styleNote}` : ''}
        </div>
        <div className="dim" style={{ fontSize: 11 }}>
          {c.background ?? ''}
          {c.birthKnown !== false ? ` · Age ${league.season - c.birthYear}` : ''}
        </div>
      </div>
      <TraitChips c={c} />
      <CoachRatingBars c={c} />
      <div className="row" style={{ fontSize: 12, gap: 14 }}>
        {c.role === 'head' && (
          <>
            <span>
              <span className="muted">With you </span>
              <b>{tw.w + tw.l + tw.otl ? recordText(tw) : '—'}</b>
            </span>
            <span>
              <span className="muted">Career </span>
              <b>{careerRecord(c)}</b>
            </span>
          </>
        )}
        <span>
          <span className="muted">Contract </span>
          <b>{c.contract ? `${fmtMoney(c.contract.salary)} × ${c.contract.years} yr` : '—'}</b>
        </span>
      </div>
      <div className="row">
        {canExtend && (
          <button className="btn small" onClick={onExtend}>
            {c.interim ? 'Remove interim tag' : 'Extend'}
          </button>
        )}
        <button className="btn small ghost" onClick={onFire}>
          Fire
        </button>
      </div>
    </div>
  );
}

function DealModal({ deal, onClose }: { deal: Deal; onClose: () => void }) {
  const { league } = useGame();
  const team = league.teams[league.userTeamId];
  const { c, role, kind } = deal;
  const a = kind === 'hire' ? coachAsk(league, c, role, team.id) : extensionAsk(league, c);
  const [salary, setSalary] = useState(a.salary);
  const [years, setYears] = useState(a.years);
  const current = coachOf(league, team, ROLE_SLOT[role]);
  const room = staffBudget(team) - staffSpend(league, team, kind === 'extend' ? c.id : current?.interim ? current.id : undefined);
  const submit = () => {
    const r = mutate((l) => (kind === 'hire' ? offerCoach(l, l.userTeamId, c.id, role, salary, years) : extendCoach(l, c.id, salary, years)));
    toast(r.message, r.ok ? 'good' : 'bad');
    if (r.ok) onClose();
  };
  return (
    <Modal title={`${kind === 'hire' ? 'Offer' : c.interim ? 'Sign' : 'Extend'} ${c.first} ${c.last}`} onClose={onClose}>
      <div className="stack" style={{ gap: 12, minWidth: 300 }}>
        <span className="muted">
          {ROLE_LABEL[role]} · He's looking for about <b>{fmtMoney(a.salary)}</b> a year over <b>{a.years}</b> years. Shorter terms cost a little more. Staff budget room: <b>{fmtMoney(room)}</b>.
        </span>
        <label className="row">
          <span style={{ width: 90 }}>Salary</span>
          <input type="range" min={Math.round(a.salary * 0.7)} max={Math.round(a.salary * 1.4)} step={25} value={salary} onChange={(e) => setSalary(Number(e.target.value))} style={{ flex: 1 }} />
          <b style={{ width: 70, textAlign: 'right' }}>{fmtMoney(salary)}</b>
        </label>
        <label className="row">
          <span style={{ width: 90 }}>Years</span>
          <input type="range" min={1} max={5} value={years} onChange={(e) => setYears(Number(e.target.value))} style={{ flex: 1 }} />
          <b style={{ width: 70, textAlign: 'right' }}>{years}</b>
        </label>
        {current && !current.interim && kind === 'hire' && <span className="pill bad">Fire {current.first} {current.last} first: the job isn't open.</span>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            {kind === 'hire' ? 'Make offer' : 'Sign'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
