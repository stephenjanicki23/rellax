import { useState } from 'react';
import type { Article } from '../../engine/types';
import { useGame } from '../store';
import { Card, Seg, TeamLogo } from '../components/common';
import { shortDate, seasonLabel } from '../format';
import { href } from '../router';

const KIND_LABEL: Record<Article['kind'], string> = { preview: 'Season preview', power: 'Power rankings', recap: 'Game recap', grade: 'Trade grade', draft: 'Draft grades' };

/** The press: previews, power rankings, recaps of your games and trade grades. */
export function MediaPage() {
  const { league } = useGame();
  const [kind, setKind] = useState<'all' | Article['kind']>('all');
  const [open, setOpen] = useState<number | null>(null);
  const all = league.media?.articles ?? [];
  const list = all.filter((a) => kind === 'all' || a.kind === kind);
  const featured = open !== null ? all.find((a) => a.id === open) : list[0];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Media</h1>
          <div className="sub">What the press is writing about your club and the league.</div>
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Seg
          value={kind}
          onChange={(k) => {
            setKind(k);
            setOpen(null);
          }}
          options={[
            { id: 'all', label: 'All' },
            { id: 'recap', label: 'Recaps' },
            { id: 'power', label: 'Power rankings' },
            { id: 'grade', label: 'Trade grades' },
            { id: 'preview', label: 'Previews' },
            { id: 'draft', label: 'Draft' },
          ]}
        />
      </div>
      {!list.length ? (
        <div className="empty">Nothing in the papers yet.</div>
      ) : (
        <div className="grid g-main">
          <div>{featured && <ArticleView a={featured} />}</div>
          <Card title="Headlines" tight>
            <div className="list" style={{ padding: '0 12px 8px', maxHeight: 640, overflow: 'auto' }}>
              {list.slice(0, 80).map((a) => (
                <button
                  key={a.id}
                  className="item"
                  onClick={() => setOpen(a.id)}
                  style={{ background: 'none', border: 0, borderBottom: '1px solid var(--line)', color: 'inherit', textAlign: 'left', cursor: 'pointer', flexDirection: 'column', alignItems: 'flex-start', gap: 2, fontWeight: featured?.id === a.id ? 700 : 400 }}
                >
                  <span className="dim" style={{ fontSize: 11 }}>
                    {KIND_LABEL[a.kind]} · {a.season === league.season ? shortDate(a.season, a.day) : seasonLabel(a.season)}
                  </span>
                  <span>{a.title}</span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

export function ArticleView({ a, compact }: { a: Article; compact?: boolean }) {
  const { league } = useGame();
  return (
    <Card>
      <div className="stack" style={{ gap: 10 }}>
        <span className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {KIND_LABEL[a.kind]} · {shortDate(a.season, a.day)}
        </span>
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          {a.grade && <span className={`pill ${a.grade.startsWith('A') || a.grade.startsWith('B') ? 'good' : a.grade.startsWith('C') ? '' : 'bad'}`} style={{ fontSize: 18, padding: '4px 10px' }}>{a.grade}</span>}
          <h2 style={{ margin: 0, fontSize: compact ? 16 : 22, lineHeight: 1.25, textTransform: 'none' }}>{a.title}</h2>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {a.teamIds.slice(0, 4).map((id) => league.teams[id] && <TeamLogo key={id} team={league.teams[id]} size={18} />)}
        </div>
        {(compact ? a.body.slice(0, 2) : a.body).map((p, i) => (
          <p key={i} style={{ margin: 0, lineHeight: 1.55, fontFamily: a.kind === 'power' ? 'inherit' : undefined }}>
            {p}
          </p>
        ))}
        {a.gameId !== undefined && !compact && <a href={href(`game/${a.gameId}`)}>Box score →</a>}
      </div>
    </Card>
  );
}
