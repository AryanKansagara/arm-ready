import type { Finding, ServiceScore, Status } from './engine/types.ts'

export const STATUS_LABEL: Record<Status, string> = { ok: 'Ready', warn: 'Warning', block: 'Blocker', unknown: 'Unverified', pending: 'Checking' }
export const STATE_LABEL: Record<ServiceScore['state'], string> = { ready: 'Ready for arm64', 'needs-work': 'Needs work', blocked: 'Blocked', scanning: 'Scanning' }

export const StatusChip = ({ s }: { s: Status }) => <span className={`chip ${s}`}><span className={`dot ${s}`} aria-hidden="true" />{STATUS_LABEL[s]}</span>

export function ScoreRing({ score, size = 64, state }: { score: number | null; size?: number; state?: ServiceScore['state'] }) {
  const r = size / 2 - 5, c = 2 * Math.PI * r
  const color = state === 'blocked' ? 'var(--tile-block)' : state === 'needs-work' ? 'var(--amber)' : state === 'ready' ? 'var(--tile-ok)' : 'var(--lavender)'
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={score === null ? 'Not scanned' : `Readiness ${score} of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth="6" />
      {score !== null && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s' }} />}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" style={{ fontSize: size * 0.27 }}>{score ?? '–'}</text>
    </svg>
  )
}

/** Stacked bar of finding states for a service. */
export function StateBar({ s }: { s: ServiceScore }) {
  const total = s.ok + s.warnings + s.blockers + s.unknown + s.pending || 1
  const seg = (n: number, color: string) => n ? <i style={{ width: `${(n / total) * 100}%`, background: color }} /> : null
  return <div className="bar" aria-hidden="true">{seg(s.ok, 'var(--tile-ok)')}{seg(s.warnings, 'var(--amber)')}{seg(s.blockers, 'var(--tile-block)')}{seg(s.unknown, 'var(--lavender)')}{seg(s.pending, 'var(--border-strong)')}</div>
}

/** Live tiles: one per service, one square per dependency, flipping as the checks land. */
export function Tiles({ services, findings, scores, onOpen }: { services: { name: string; language?: string }[]; findings: Finding[]; scores: ServiceScore[]; onOpen?: (name: string) => void }) {
  return (
    <div className="tiles">
      {services.map(svc => {
        const fs = findings.filter(f => f.service === svc.name)
        const sc = scores.find(s => s.name === svc.name)
        const worst = fs.find(f => f.status === 'block') ?? fs.find(f => f.status === 'warn')
        const Tag = onOpen ? 'button' : 'div'
        return (
          <Tag key={svc.name} type={onOpen ? 'button' : undefined} className={`tile st-${sc?.state ?? 'scanning'}`} onClick={onOpen ? () => onOpen(svc.name) : undefined} aria-label={`${svc.name}: ${sc ? STATE_LABEL[sc.state] : 'Scanning'}, ${fs.length} checks`}>
            <div className="tile-head"><span className="tile-name">{svc.name}</span><span className="tile-score">{sc && sc.state !== 'scanning' ? sc.score : '··'}</span></div>
            <div className="tile-lang">{svc.language ?? 'Third-party image'} · {fs.length} checks</div>
            <div className="deps" aria-hidden="true">{fs.map(f => <span key={f.id} className={`dep ${f.status}`} title={`${f.name}: ${f.title}`} />)}</div>
            <div className="tile-foot">{sc?.state === 'scanning' ? `checking ${fs.find(f => f.status === 'pending')?.name ?? ''}` : worst ? `${worst.status === 'block' ? '✕' : '!'} ${worst.title}` : '✓ all checks pass'}</div>
          </Tag>
        )
      })}
    </div>
  )
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo'
