import { useEffect, useState } from 'react'
import { repoScore, scoreServices } from './engine/classify.ts'
import { createBlankProject, createSampleProject } from './projectData.ts'
import { deleteProject, useProjects, type Project } from './store.ts'
import { Empty, go, Link, Modal, SyntheticBadge, toast } from './ui.tsx'
import { ScoreRing } from './widgets.tsx'

export function projectSummary(p: Project) {
  if (!p.findings) return null
  const scores = scoreServices(p.services.map(s => s.name), p.findings)
  return { score: repoScore(scores), scores, blockers: p.findings.filter(f => f.status === 'block').length, warnings: p.findings.filter(f => f.status === 'warn').length, state: scores.some(s => s.state === 'blocked') ? 'blocked' as const : scores.some(s => s.state === 'needs-work') ? 'needs-work' as const : 'ready' as const }
}

export const fmtDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export default function Workspace() {
  const list = useProjects()
  const [naming, setNaming] = useState(false)
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (q.get('import') === '1') { history.replaceState({}, '', '/app'); setNaming(true) }
    if (q.get('sample') === '1') { const tab = q.get('tab'); void createSampleProject().then(p => go(`/app/p/${p.id}${tab && /^[a-z]+$/.test(tab) ? '/' + tab : ''}?scan=1`, { replace: true })) }
  }, [])

  const create = async (name: string) => {
    const p = await createBlankProject(name || 'My platform repo')
    go(`/app/p/${p.id}/files?import=1`)
  }
  const sample = async () => { const p = await createSampleProject(); go(`/app/p/${p.id}${p.findings ? '' : '?scan=1'}`) }

  if (list === null) return <div className="boot" role="status"><span className="spinner" /> Loading</div>
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Repos</h1>
          <p className="muted">One entry per repo or platform. Each keeps its files, scan results, worklist, costing and a history of every scan.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setNaming(true)}>New repo scan</button>
      </div>

      {list.length === 0 ? (
        <Empty title="No repos scanned yet" icon={<EmptyArt />}>
          <p className="muted">Start with the synthetic shopfront repo to see a full scan, or import your own Dockerfiles, manifests and lockfiles. Nothing leaves your browser except image and package names sent to public registries.</p>
          <div className="row gap center-x wrap">
            <button type="button" className="btn primary" onClick={() => void sample()}>Try the sample</button>
            <button type="button" className="btn outline" onClick={() => setNaming(true)}>Import your data</button>
          </div>
        </Empty>
      ) : (
        <div className="proj-grid">
          {list.map(p => {
            const s = projectSummary(p)
            return (
              <article key={p.id} className="card proj">
                <Link href={`/app/p/${p.id}`} className="proj-link">
                  <ScoreRing score={s?.score ?? null} state={s?.state} />
                  <div style={{ minWidth: 0 }}>
                    <h3>{p.name} {p.sampleId && <SyntheticBadge />}</h3>
                    <p className="muted small" style={{ margin: 0 }}>
                      {p.services.length} services · {p.files.length} files{p.scannedAt ? ` · scanned ${fmtDate(p.scannedAt)}` : ' · not scanned yet'}
                    </p>
                    {s && <p className="small" style={{ margin: '.3rem 0 0' }}><span className="block-t">{s.blockers} blockers</span> · <span className="warn-t">{s.warnings} warnings</span> · {p.snapshots.length} scans</p>}
                  </div>
                </Link>
                <div className="proj-actions">
                  <Link href={`/app/p/${p.id}/worklist`} className="btn ghost sm">Worklist</Link>
                  <Link href={`/app/p/${p.id}/report`} className="btn ghost sm">Report</Link>
                  <button type="button" className="btn danger-ghost sm" style={{ marginLeft: 'auto' }} onClick={async () => {
                    const undo = await deleteProject(p.id)
                    toast(`Deleted ${p.name}.`, { undo: () => void undo() })
                  }}>Delete</button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {list.length > 0 && !list.some(p => p.sampleId) && (
        <div className="samples">
          <h2 className="h4">Sample</h2>
          <button type="button" className="card pad" style={{ textAlign: 'left', width: '100%', maxWidth: 420 }} onClick={() => void sample()}>
            <strong>shopfront</strong> <SyntheticBadge />
            <p className="muted small" style={{ margin: '.3rem 0 0' }}>Python, Node with native addons, Go with cgo, Java with JNI, and an amd64-only vendor database.</p>
          </button>
        </div>
      )}

      <Modal open={naming} onClose={() => setNaming(false)} title="New repo scan">
        <form onSubmit={e => { e.preventDefault(); void create(String(new FormData(e.currentTarget).get('name') ?? '').trim()) }} className="stack">
          <label className="field"><span>Repo or platform name</span><input name="name" autoFocus placeholder="payments-platform" /></label>
          <p className="muted small">Next you will drop in Dockerfiles, Compose or Kubernetes YAML and lockfiles. A whole folder works too.</p>
          <div className="row end gap"><button type="button" className="btn ghost" onClick={() => setNaming(false)}>Cancel</button><button className="btn primary">Create and import</button></div>
        </form>
      </Modal>
    </section>
  )
}

const EmptyArt = () => (
  <svg className="empty-art" viewBox="0 0 150 96" aria-hidden="true">
    {[0, 1, 2].map(r => [0, 1, 2, 3, 4].map(c => <rect key={`${r}${c}`} x={8 + c * 28} y={8 + r * 28} width="22" height="22" rx="6" fill={(r + c) % 3 === 0 ? 'var(--tile-ok)' : (r * c) % 4 === 1 ? 'var(--tile-pending)' : 'var(--surface-2)'} opacity={(r + c) % 3 === 0 ? 0.9 : 1} />))}
  </svg>
)
