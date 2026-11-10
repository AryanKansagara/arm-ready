import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { worklist, worklistCsv, type WorkState } from './engine/actions.ts'
import { repoScore, scoreServices } from './engine/classify.ts'
import { costLine, costSummary, DEFAULT_PRICES } from './engine/cost.ts'
import type { Finding, ServiceScore, Status } from './engine/types.ts'
import { runScan, seedSampleHistory, useProject, type ScanProgress } from './projectData.ts'
import { getProject, saveProject, type Project as P, type Snapshot } from './store.ts'
import { deleteSnapshotCloud } from './sync.ts'
import { download, Empty, fmtUsd, go, isTyping, Link, NotFound, SyntheticBadge, toast } from './ui.tsx'
import { ScoreRing, slug, STATE_LABEL, StateBar, StatusChip, Tiles } from './widgets.tsx'
import { fmtDate } from './Workspace.tsx'

const Files = lazy(() => import('./Files.tsx'))
const Cost = lazy(() => import('./Cost.tsx'))
const Actions = lazy(() => import('./Actions.tsx'))

const TABS = [['overview', 'Overview'], ['worklist', 'Worklist'], ['files', 'Files'], ['cost', 'Cost'], ['actions', 'Actions'], ['history', 'History']] as const

// One scan at a time per project, kept outside React so navigating between tabs does not cancel it.
const scans = new Map<string, { progress: ScanProgress | null; subs: Set<() => void> }>()
function useScanner(id: string) {
  const [, force] = useState(0)
  useEffect(() => {
    const s = scans.get(id)
    if (!s) return
    const f = () => force(n => n + 1)
    s.subs.add(f)
    return () => { s.subs.delete(f) }
  })
  const entry = scans.get(id)
  const start = async () => {
    if (scans.has(id)) return
    const e = { progress: null as ScanProgress | null, subs: new Set<() => void>() }
    scans.set(id, e)
    const ping = () => e.subs.forEach(f => f())
    force(n => n + 1)
    try {
      const p = await runScan(id, pr => { e.progress = pr; ping() })
      if (p?.sampleId && p.snapshots.length === 1) await seedSampleHistory(id)
      if (p) {
        const s = scoreServices(p.services.map(x => x.name), p.findings ?? [])
        toast(`Scan finished: readiness ${repoScore(s)}, ${p.findings!.filter(f => f.status === 'block').length} blockers.`, { tone: 'ok' })
      }
    } catch (err) {
      toast('Scan failed: ' + (err instanceof Error ? err.message : String(err)), { tone: 'error' })
    } finally {
      scans.delete(id)
      ping()
      force(n => n + 1)
    }
  }
  return { running: !!entry, progress: entry?.progress ?? null, start }
}

export default function ProjectView({ id, tab }: { id: string; tab: string }) {
  const { loading, project, files } = useProject(id)
  const scan = useScanner(id)
  useEffect(() => { if (project) document.title = `${project.name} · Arm Ready` }, [project?.name])
  useEffect(() => {
    if (!project) return
    if (new URLSearchParams(location.search).get('scan') === '1') {
      history.replaceState({}, '', location.pathname)
      if (!project.findings || project.sampleId) void scan.start()
    }
  }, [project?.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const i = Number(e.key) - 1
      if (i >= 0 && i < TABS.length) go(`/app/p/${id}${i ? '/' + TABS[i][0] : ''}`, { keepScroll: true })
      if (e.key === 'r' && files.length) void scan.start()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [id, files.length])

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Loading</div>
  if (!project) return <NotFound />
  const t = TABS.some(([k]) => k === tab) ? tab : 'overview'
  const live = scan.progress?.findings ?? null
  const findings = live ?? project.findings ?? []
  const open = project.findings ? worklist(project.findings).filter(f => (project.work[f.id] ?? 'open') !== 'done' && project.work[f.id] !== 'wontfix').length : 0

  return (
    <section className="page project">
      <div className="proj-head">
        <div>
          <p className="eyebrow"><Link href="/app">Repos</Link> / {project.sampleId ? 'Sample' : 'Your repo'}</p>
          <h1>{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          <p className="muted small" style={{ margin: '.4rem 0 0' }}>{project.files.length} files · {project.services.length} services · {project.scannedAt ? `last scan ${new Date(project.scannedAt).toLocaleString()}` : 'not scanned yet'}</p>
        </div>
        <div className="row gap-sm wrap">
          <button type="button" className="btn primary" disabled={scan.running || !files.length} onClick={() => void scan.start()} title="Shortcut: R">
            {scan.running ? <><span className="spinner" style={{ borderTopColor: '#fff' }} /> Scanning {scan.progress ? `${scan.progress.done}/${scan.progress.total}` : ''}</> : project.findings ? 'Re-scan' : 'Run scan'}
          </button>
          {project.findings && <Link href={`/app/p/${id}/report`} className="btn ghost">Printable report</Link>}
        </div>
      </div>
      {project.dataMissing && <div className="banner warn" style={{ marginBottom: '1rem' }}>This repo was synced from another device and its raw files were too large to sync. Results, worklist, costing and history are here; re-import the files on this device to re-scan.</div>}
      <nav className="tabs" aria-label="Repo sections">
        {TABS.map(([k, l]) => <Link key={k} href={`/app/p/${id}${k === 'overview' ? '' : '/' + k}`} aria-current={t === k ? 'page' : undefined}>{l}{k === 'worklist' && open > 0 && <span className="count">{open}</span>}</Link>)}
      </nav>

      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {t === 'files' ? <Files project={project} files={files} onScan={() => void scan.start()} />
          : t === 'cost' ? <Cost project={project} />
            : !project.findings && !live ? (
              <Empty title={files.length ? 'Ready to scan' : 'Import files to start'}>
                <p className="muted">{files.length ? `${files.length} files imported. The scan checks each image and package against public registries; it takes under a minute for most repos.` : 'Add Dockerfiles, Compose or Kubernetes YAML, and lockfiles. Folders work too.'}</p>
                <div className="row gap center-x wrap">
                  {files.length ? <button type="button" className="btn primary" onClick={() => void scan.start()}>Run scan</button> : <Link href={`/app/p/${id}/files?import=1`} className="btn primary">Import files</Link>}
                  <Link href="/docs" className="btn outline">What to upload</Link>
                </div>
              </Empty>
            )
              : t === 'overview' ? <Overview p={project} findings={findings} scanning={!!live} progress={scan.progress} />
                : t === 'worklist' ? <Worklist p={project} />
                  : t === 'actions' ? <Actions project={project} files={files} />
                    : <History p={project} />}
      </Suspense>
    </section>
  )
}

// ---------- Overview ----------

function Overview({ p, findings, scanning, progress }: { p: P; findings: Finding[]; scanning: boolean; progress: ScanProgress | null }) {
  const names = p.services.map(s => s.name)
  const scores = scoreServices(names.length ? names : [...new Set(findings.map(f => f.service))], findings)
  const n = (s: Status) => findings.filter(f => f.status === s).length
  const cost = useMemo(() => p.inventory.length ? costSummary(p.inventory.map(r => costLine(r, p.prices ?? DEFAULT_PRICES, p.cost.gen, p.cost.perf))) : null, [p])
  const top = worklist(findings).filter(f => f.status === 'block').slice(0, 6)
  const svcOrder = [...scores].sort((a, b) => a.score - b.score)
  const prev = p.snapshots[p.snapshots.length - 2]
  const score = repoScore(scores)
  return (
    <div className="stack-lg">
      <div className="kpis">
        <div className="kpi card row gap">
          <ScoreRing score={scanning ? null : score} size={70} state={scores.some(s => s.state === 'blocked') ? 'blocked' : scores.some(s => s.state === 'needs-work') ? 'needs-work' : 'ready'} />
          <div><div className="kpi-label">Readiness</div><div className="kpi-sub">{scanning ? 'scanning…' : prev ? `${score - prev.score >= 0 ? '+' : ''}${score - prev.score} since ${fmtDate(prev.createdAt)}` : 'mean of service scores'}</div></div>
        </div>
        <div className="kpi card"><div className="kpi-label">Blockers</div><div className="kpi-value block-t">{n('block')}</div><div className="kpi-sub">{scores.filter(s => s.state === 'blocked').length} of {scores.length} services blocked</div></div>
        <div className="kpi card"><div className="kpi-label">Warnings · unverified</div><div className="kpi-value"><span className="warn-t">{n('warn')}</span> <span className="muted" style={{ fontSize: '1.2rem' }}>· {n('unknown')}</span></div><div className="kpi-sub">{n('ok')} checks pass</div></div>
        <div className="kpi card"><div className="kpi-label">Monthly compute change</div>
          {cost ? <><div className={`kpi-value ${cost.delta <= 0 ? 'ok-t' : 'block-t'}`}>{cost.delta <= 0 ? '−' : '+'}{fmtUsd(Math.abs(cost.delta))}</div><div className="kpi-sub">{(cost.pct * 100).toFixed(1)}% vs {fmtUsd(cost.current)} today · <Link href={`/app/p/${p.id}/cost`}>model</Link></div></>
            : <><div className="kpi-value muted">–</div><div className="kpi-sub"><Link href={`/app/p/${p.id}/cost`}>Add an instance inventory</Link></div></>}
        </div>
      </div>

      {scanning ? (
        <div className="card pad" style={{ background: 'var(--indigo)', borderColor: '#2c2068' }}>
          <div className="row between wrap gap-sm" style={{ color: '#c9c4e6', marginBottom: '.8rem' }}><strong style={{ color: '#fff' }}>Live scan</strong><span className="small">{progress?.done ?? 0} of {progress?.total ?? 0} lookups</span></div>
          <div className="scan-bar" style={{ margin: '0 0 .9rem' }}><i style={{ width: `${progress?.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <Tiles services={svcOrder.map(s => p.services.find(x => x.name === s.name) ?? { name: s.name })} findings={findings} scores={scores} />
        </div>
      ) : (
        <div>
          <h2 className="h4">Services</h2>
          <div className="svc-grid">
            {svcOrder.map(s => <ServiceCard key={s.name} s={s} p={p} findings={findings} />)}
          </div>
        </div>
      )}

      {!scanning && top.length > 0 && (
        <div className="card pad">
          <div className="row between wrap gap-sm"><h2 className="h4" style={{ margin: 0 }}>Top blockers</h2><Link href={`/app/p/${p.id}/worklist`} className="btn ghost sm">Full worklist</Link></div>
          <ul className="diff-list" style={{ marginTop: '1rem' }}>
            {top.map(f => <li key={f.id}><StatusChip s={f.status} /><span><b>{f.service}</b> · {f.title} <span className="where">{f.file}:{f.line}</span></span></li>)}
          </ul>
        </div>
      )}
      {!scanning && <CiNote findings={findings} p={p} />}
    </div>
  )
}

function ServiceCard({ s, p, findings }: { s: ServiceScore; p: P; findings: Finding[] }) {
  const svc = p.services.find(x => x.name === s.name)
  const worst = findings.find(f => f.service === s.name && f.status === 'block') ?? findings.find(f => f.service === s.name && f.status === 'warn')
  return (
    <button type="button" className={`card svc st-${s.state}`} onClick={() => go(`/app/p/${p.id}/worklist?service=${encodeURIComponent(s.name)}`)}>
      <div className="row between gap-sm"><h3>{s.name}</h3><ScoreRing score={s.score} size={44} state={s.state} /></div>
      <div className="small muted">{svc?.language ?? (svc?.dockerfile ? 'Container' : 'Third-party image')}{svc?.dockerfile ? ` · ${svc.dockerfile}` : ''}</div>
      <StateBar s={s} />
      <div className="row between small"><span className={`state ${s.state}`}>{STATE_LABEL[s.state]}</span><span className="muted">{s.blockers} blk · {s.warnings} warn · {s.ok} ok</span></div>
      {worst && <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{worst.title}</div>}
    </button>
  )
}

function CiNote({ findings, p }: { findings: Finding[]; p: P }) {
  const compiles = findings.filter(f => f.status === 'warn' && /compil|node-gyp|cgo|source/i.test(f.title)).length
  return (
    <div className="card pad grid-2">
      <div>
        <h2 className="h4">CI: build natively, not under QEMU</h2>
        <p className="muted small">{compiles ? `${compiles} dependencies compile native code during the build (wheels from source, node-gyp, cgo). ` : ''}Under QEMU emulation those steps typically run 3 to 10 times slower. GitHub's ubuntu-24.04-arm runners (and Graviton CodeBuild or self-hosted runners) build arm64 natively; merge both platforms into one tag with buildx imagetools.</p>
        <Link href={`/app/p/${p.id}/actions`} className="btn outline sm">Get the workflow</Link>
      </div>
      <div>
        <h2 className="h4">Roll out per node pool</h2>
        <p className="muted small">Add an arm64 node group next to the x86 one, publish multi-arch images, then move workloads with nodeSelector patches one service at a time. Keep blocked services (vendor images) on x86 until the vendor ships arm64.</p>
        <Link href={`/app/p/${p.id}/actions#k8s`} className="btn outline sm">Generate patches</Link>
      </div>
    </div>
  )
}

// ---------- Worklist ----------

const WORK_LABEL: Record<WorkState, string> = { open: 'Open', doing: 'In progress', done: 'Done', wontfix: "Won't fix" }

function Worklist({ p }: { p: P }) {
  const q0 = new URLSearchParams(location.search)
  const [status, setStatus] = useState<'all' | Status>('all')
  const [service, setService] = useState(q0.get('service') ?? 'all')
  const [eco, setEco] = useState('all')
  const [q, setQ] = useState('')
  const [showOk, setShowOk] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === '/' && !isTyping(e)) { e.preventDefault(); search.current?.focus() } }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
  const all = p.findings ?? []
  const base = showOk ? [...worklist(all), ...all.filter(f => f.status === 'ok')] : worklist(all)
  const rows = base.filter(f => (status === 'all' || f.status === status) && (service === 'all' || f.service === service) && (eco === 'all' || f.ecosystem === eco) && (!q || `${f.name} ${f.title} ${f.file} ${f.detail}`.toLowerCase().includes(q.toLowerCase())))
  const setWork = (fid: string, w: WorkState) => void saveProject({ ...p, work: { ...p.work, [fid]: w } })
  const done = worklist(all).filter(f => p.work[f.id] === 'done' || p.work[f.id] === 'wontfix').length
  const total = worklist(all).length
  return (
    <div className="stack">
      <div className="card pad">
        <div className="row between wrap gap"><div><h2 className="h4" style={{ marginBottom: '.2rem' }}>Migration worklist</h2><p className="muted small" style={{ margin: 0 }}>{done} of {total} items closed. Status is saved per finding and carried across re-scans.</p></div>
          <button type="button" className="btn primary sm" onClick={() => download(`${slug(p.name)}-arm64-worklist.csv`, worklistCsv(all, p.work))}>Download CSV</button></div>
        <div className="progress" style={{ marginTop: '.9rem' }}><i style={{ width: `${total ? (done / total) * 100 : 100}%` }} /></div>
      </div>
      <div className="filters">
        <input ref={search} type="search" placeholder="Search  ( / )" value={q} onChange={e => setQ(e.target.value)} aria-label="Search findings" />
        <select value={status} onChange={e => setStatus(e.target.value as Status | 'all')} aria-label="Severity"><option value="all">All severities</option><option value="block">Blockers</option><option value="warn">Warnings</option><option value="unknown">Unverified</option>{showOk && <option value="ok">Ready</option>}</select>
        <select value={service} onChange={e => setService(e.target.value)} aria-label="Service"><option value="all">All services</option>{p.services.map(s => <option key={s.name}>{s.name}</option>)}</select>
        <select value={eco} onChange={e => setEco(e.target.value)} aria-label="Ecosystem"><option value="all">All types</option>{[...new Set(all.map(f => f.ecosystem))].sort().map(x => <option key={x}>{x}</option>)}</select>
        <label className="row gap-sm small"><input type="checkbox" checked={showOk} onChange={e => setShowOk(e.target.checked)} /> Show passing checks</label>
        <span className="muted small" style={{ marginLeft: 'auto' }}>{rows.length} shown</span>
      </div>
      {rows.length === 0 ? <Empty title={total ? 'Nothing matches these filters' : 'No issues found'}><p className="muted">{total ? 'Clear a filter to see more.' : 'Every image and package checked out for linux/arm64.'}</p></Empty> : (
        <div className="card table-card">
          <table className="vt stack-sm-table">
            <thead><tr><th>Severity</th><th>Item</th><th>Issue and fix</th><th>Effort</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map(f => (
                <tr key={f.id} className={p.work[f.id] === 'done' || p.work[f.id] === 'wontfix' ? 'done' : ''}>
                  <td><StatusChip s={f.status} /></td>
                  <td style={{ minWidth: 180, maxWidth: 280 }}><div className="item-name">{f.name}{f.version ? <span className="muted"> {f.version}</span> : ''}</div><div className="where">{f.service} · {f.ecosystem} · {f.file}:{f.line}</div></td>
                  <td className="wide-cell"><div><b>{f.title}</b></div><div className="small muted">{f.detail}</div>{f.fix && <div className="fix"><b>Fix:</b> {f.fix}</div>}{f.source && <div className="tiny muted">Source: {f.source}</div>}</td>
                  <td>{f.status !== 'ok' && f.effort}</td>
                  <td>{f.status !== 'ok' && <select value={p.work[f.id] ?? 'open'} onChange={e => setWork(f.id, e.target.value as WorkState)} aria-label={`Status for ${f.name}`}>{(Object.keys(WORK_LABEL) as WorkState[]).map(w => <option key={w} value={w}>{WORK_LABEL[w]}</option>)}</select>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// ---------- History ----------

function Trend({ snaps }: { snaps: Snapshot[] }) {
  const W = 640, H = 180, pad = 28
  if (snaps.length < 2) return <p className="muted small">Run another scan after making changes to see a trend.</p>
  const x = (i: number) => pad + (i * (W - pad * 2)) / (snaps.length - 1)
  const y = (s: number) => H - pad - (s / 100) * (H - pad * 2)
  const pts = snaps.map((s, i) => `${x(i)},${y(s.score)}`).join(' ')
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Readiness trend from ${snaps[0].score} to ${snaps[snaps.length - 1].score}`}>
      {[0, 50, 100].map(v => <g key={v}><line className="axis" x1={pad} x2={W - pad} y1={y(v)} y2={y(v)} /><text x={4} y={y(v) + 4}>{v}</text></g>)}
      <polygon className="area" points={`${x(0)},${y(0)} ${pts} ${x(snaps.length - 1)},${y(0)}`} />
      <polyline className="line" points={pts} />
      {snaps.map((s, i) => <g key={s.id}><circle cx={x(i)} cy={y(s.score)} r="4.5" /><text x={x(i)} y={y(s.score) - 10} textAnchor="middle">{s.score}</text></g>)}
    </svg>
  )
}

function History({ p }: { p: P }) {
  const snaps = [...p.snapshots].sort((a, b) => a.createdAt - b.createdAt)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  // Default to the last two scans; follows new scans until the user picks.
  const A = snaps.find(s => s.id === a) ?? snaps[snaps.length - 2], B = snaps.find(s => s.id === b) ?? snaps[snaps.length - 1]
  const del = async (s: Snapshot) => {
    const cur = getProject(p.id)!
    await saveProject({ ...cur, snapshots: cur.snapshots.filter(x => x.id !== s.id) })
    void deleteSnapshotCloud(s.id)
    toast(`Deleted scan from ${fmtDate(s.createdAt)}.`, { undo: () => { const c = getProject(p.id)!; void saveProject({ ...c, snapshots: [...c.snapshots, s] }) } })
  }
  return (
    <div className="stack-lg">
      <div className="card pad">
        <h2 className="h4">Readiness over time</h2>
        <Trend snaps={snaps} />
      </div>
      {A && B && A.id !== B.id && <Compare A={A} B={B} />}
      <div className="card table-card">
        <table className="vt">
          <thead><tr><th>Scan</th><th>Date</th><th className="num">Readiness</th><th className="num">Blockers</th><th>Compare</th><th><span className="sr-only">Delete</span></th></tr></thead>
          <tbody>{[...snaps].reverse().map(s => (
            <tr key={s.id}>
              <th scope="row">{s.label}</th><td>{new Date(s.createdAt).toLocaleString()}</td><td className="num">{s.score}</td>
              <td className="num">{s.services.reduce((n, x) => n + x.blockers, 0)}</td>
              <td><div className="seg"><button type="button" aria-pressed={A?.id === s.id} onClick={() => setA(s.id)}>Before</button><button type="button" aria-pressed={B?.id === s.id} onClick={() => setB(s.id)}>After</button></div></td>
              <td><button type="button" className="btn danger-ghost sm" onClick={() => void del(s)}>Delete</button></td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Compare({ A, B }: { A: Snapshot; B: Snapshot }) {
  const [before, after] = A.createdAt <= B.createdAt ? [A, B] : [B, A]
  const fixed = Object.entries(before.items).filter(([id, v]) => (v.s === 'block' || v.s === 'warn') && !(after.items[id]?.s === v.s))
  const added = Object.entries(after.items).filter(([id, v]) => (v.s === 'block' || v.s === 'warn') && before.items[id]?.s !== v.s)
  const svcs = [...new Set([...before.services.map(s => s.name), ...after.services.map(s => s.name)])]
  return (
    <div className="card pad">
      <h2 className="h4">What changed: {fmtDate(before.createdAt)} to {fmtDate(after.createdAt)} <span className={after.score >= before.score ? 'ok-t' : 'block-t'}>({after.score - before.score >= 0 ? '+' : ''}{after.score - before.score})</span></h2>
      <div className="grid-2">
        <div>
          <h3 className="small muted">Resolved ({fixed.length})</h3>
          {fixed.length ? <ul className="diff-list">{fixed.map(([id, v]) => <li key={id}><span className="ok-t">✓</span><span><b>{v.svc}</b> · {v.t} <span className="muted small">({v.n})</span></span></li>)}</ul> : <p className="muted small">Nothing resolved.</p>}
          <h3 className="small muted" style={{ marginTop: '1rem' }}>New or worse ({added.length})</h3>
          {added.length ? <ul className="diff-list">{added.map(([id, v]) => <li key={id}><span className="block-t">+</span><span><b>{v.svc}</b> · {v.t} <span className="muted small">({v.n})</span></span></li>)}</ul> : <p className="muted small">No new issues.</p>}
        </div>
        <div>
          <h3 className="small muted">Service scores</h3>
          <table className="vt compact"><tbody>{svcs.map(n => {
            const x = before.services.find(s => s.name === n)?.score, y = after.services.find(s => s.name === n)?.score
            const d = (y ?? 0) - (x ?? 0)
            return <tr key={n}><th scope="row">{n}</th><td className="num muted">{x ?? '–'}</td><td className="num">{y ?? '–'}</td><td className={`num ${d > 0 ? 'ok-t' : d < 0 ? 'block-t' : 'muted'}`}>{x === undefined || y === undefined ? (y === undefined ? 'removed' : 'new') : `${d > 0 ? '+' : ''}${d}`}</td></tr>
          })}</tbody></table>
        </div>
      </div>
    </div>
  )
}
