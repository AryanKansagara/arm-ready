import { useEffect, useRef, useState } from 'react'
import { parseManifestExport } from './engine/classify.ts'
import { guessColumns, parseCsv, parseInventory, type ColumnMap } from './engine/cost.ts'
import { analyze, detectKind, KIND_LABEL } from './engine/parse.ts'
import type { FileIssue, FileKind, Platform, RepoFile } from './engine/types.ts'
import { getProject, putData, saveProject, type Project } from './store.ts'
import { ask, Link, Modal, toast } from './ui.tsx'

const MAX_FILE = 8_000_000

interface Pending { path: string; text: string; kind: FileKind }

async function readAll(list: FileList | File[]): Promise<Pending[]> {
  const out: Pending[] = []
  for (const f of Array.from(list)) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    if (/(^|\/)(node_modules|\.git|vendor|target|dist)\//.test(path)) continue
    if (f.size > MAX_FILE) { toast(`${path} is over 8 MB and was skipped.`, { tone: 'error' }); continue }
    const text = await f.text()
    const kind = detectKind(path, text)
    // A folder upload brings everything; keep only what the scanner reads.
    if (kind === 'unknown' && list.length > 3) continue
    out.push({ path, text, kind })
  }
  return out
}

export default function Files({ project: p, files, onScan }: { project: Project; files: RepoFile[]; onScan(): void }) {
  const [staged, setStaged] = useState<Pending[] | null>(null)
  const [paste, setPaste] = useState(false)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (new URLSearchParams(location.search).get('import') === '1') { history.replaceState({}, '', location.pathname); setTimeout(() => input.current?.click(), 50) }
  }, [])

  const stage = async (list: FileList | File[]) => {
    const got = await readAll(list)
    if (!got.length) { toast('No Dockerfiles, manifests or lockfiles found in that selection.', { tone: 'error' }); return }
    setStaged(got)
  }
  const reports = p.files
  const overrides = Object.entries(p.overrides)

  return (
    <div className="stack-lg">
      <div className="card pad stack">
        <div className="row between wrap gap">
          <div><h2 className="h4" style={{ marginBottom: '.2rem' }}>Import</h2><p className="muted small" style={{ margin: 0 }}>Files are parsed in your browser. Re-importing a path replaces it.</p></div>
          <div className="row gap-sm wrap"><Link href="/docs" className="btn ghost sm">What to upload</Link><button type="button" className="btn ghost sm" onClick={() => setPaste(true)}>Paste text</button></div>
        </div>
        <label className={`drop${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); void stage(e.dataTransfer.files) }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
          <strong>Drop files here or click to choose</strong>
          <span className="muted small">Dockerfile · docker-compose.yml · K8s/Helm YAML · requirements.txt · poetry.lock · package-lock.json · go.mod · pom.xml · Gradle list · Cargo.lock · instance CSV · manifest export (.jsonl)</span>
          <input ref={input} type="file" multiple className="sr-only" onChange={e => { if (e.target.files) void stage(e.target.files); e.target.value = '' }} />
        </label>
        <div className="row gap-sm wrap">
          <button type="button" className="btn outline sm" onClick={() => folder.current?.click()}>Choose a folder</button>
          <input ref={folder} type="file" className="sr-only" multiple {...{ webkitdirectory: '' }} onChange={e => { if (e.target.files) void stage(e.target.files); e.target.value = '' }} aria-label="Choose a folder" />
          {files.length > 0 && <button type="button" className="btn primary sm" onClick={onScan}>Scan {files.length} files</button>}
        </div>
      </div>

      {reports.length > 0 && (
        <div className="card table-card">
          <div className="pad" style={{ paddingBottom: 0 }}><h2 className="h4">Validation report</h2></div>
          <table className="vt">
            <thead><tr><th>File</th><th>Detected as</th><th className="num">Lines</th><th className="num">Checks</th><th>Notes</th><th><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{reports.map(r => (
              <tr key={r.path}>
                <th scope="row" className="mono" style={{ wordBreak: 'break-all' }}>{r.path}</th>
                <td>{KIND_LABEL[r.kind]}</td><td className="num">{r.lines}</td><td className="num">{r.items}</td>
                <td><Issues issues={r.issues} /></td>
                <td><button type="button" className="btn danger-ghost sm" onClick={() => void removeFile(p, files, r.path)}>Remove</button></td>
              </tr>))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card pad">
        <h2 className="h4">Imported image manifests</h2>
        <p className="muted small">For private registries or when a live lookup fails: run the CLI export from the Actions tab and import its .jsonl here. These platform lists override live lookups.</p>
        {overrides.length ? <table className="vt compact"><tbody>{overrides.map(([ref, ps]) => (
          <tr key={ref}><th scope="row" className="mono">{ref}</th><td>{ps.map(x => x.architecture + (x.variant ? '/' + x.variant : '')).join(', ')}</td>
            <td><button type="button" className="btn danger-ghost sm" onClick={() => { const o = { ...p.overrides }; delete o[ref]; void saveProject({ ...p, overrides: o }); toast(`Removed ${ref}.`, { undo: () => void saveProject({ ...getProject(p.id)!, overrides: { ...getProject(p.id)!.overrides, [ref]: ps } }) }) }}>Remove</button></td></tr>))}
        </tbody></table> : <p className="muted small">None yet.</p>}
      </div>

      {files.length > 0 && !p.sampleId && (
        <div className="card pad danger-zone">
          <h2 className="h4">Clear all files</h2>
          <p className="muted small">Removes the uploaded files from this device. Results and history stay until the next scan.</p>
          <button type="button" className="btn danger-ghost sm" onClick={async () => {
            if (!(await ask('Clear all files?', 'Every uploaded file is removed from this repo. You can undo for a few seconds.', 'Clear files'))) return
            const prev = files, prevReports = p.files
            await putData(p.id, [])
            await saveProject({ ...p, files: [] })
            toast('Files cleared.', { undo: async () => { await putData(p.id, prev); await saveProject({ ...getProject(p.id)!, files: prevReports }) } })
          }}>Clear files</button>
        </div>
      )}

      <StageModal staged={staged} onClose={() => setStaged(null)} p={p} files={files} />
      <PasteModal open={paste} onClose={() => setPaste(false)} onAdd={t => { setPaste(false); setStaged([t]) }} />
    </div>
  )
}

function Issues({ issues }: { issues: FileIssue[] }) {
  if (!issues.length) return <span className="ok-t small">OK</span>
  return <ul className="issues">{issues.map((i, k) => <li key={k}><span className={i.level === 'error' ? 'block-t' : i.level === 'warn' ? 'warn-t' : 'muted'}>{i.level === 'error' ? '✕' : i.level === 'warn' ? '!' : 'i'}</span><span className="mono">line {i.line}</span><span>{i.message}</span></li>)}</ul>
}

async function removeFile(p: Project, files: RepoFile[], path: string) {
  const next = files.filter(f => f.path !== path)
  await putData(p.id, next)
  const a = analyze(next)
  await saveProject({ ...p, files: a.files, services: a.services })
  toast(`Removed ${path}.`, { undo: async () => { await putData(p.id, files); const b = analyze(files); await saveProject({ ...getProject(p.id)!, files: b.files, services: b.services }) } })
}

function StageModal({ staged, onClose, p, files }: { staged: Pending[] | null; onClose(): void; p: Project; files: RepoFile[] }) {
  const repo = staged?.filter(s => s.kind !== 'inventory' && s.kind !== 'manifests' && s.kind !== 'unknown') ?? []
  const inv = staged?.find(s => s.kind === 'inventory')
  const manis = staged?.filter(s => s.kind === 'manifests') ?? []
  const unknown = staged?.filter(s => s.kind === 'unknown') ?? []
  const preview = repo.length ? analyze(repo) : null
  const [map, setMap] = useState<ColumnMap | null>(null)
  useEffect(() => { setMap(inv ? guessColumns(parseCsv(inv.text)[0] ?? []) : null) }, [inv?.text])
  const invParsed = inv && map ? parseInventory(inv.text, map) : null
  const maniRows = manis.flatMap(m => parseManifestExport(m.text).map(r => ({ ...r, file: m.path })))
  const errors = (preview?.files.reduce((n, f) => n + f.issues.filter(i => i.level === 'error').length, 0) ?? 0)

  const commit = async () => {
    let next = p
    if (repo.length) {
      const merged = [...files.filter(f => !repo.some(r => r.path === f.path)), ...repo.map(r => ({ path: r.path, text: r.text }))]
      await putData(p.id, merged)
      const a = analyze(merged)
      next = { ...next, files: a.files, services: a.services }
    }
    if (invParsed?.rows.length) next = { ...next, inventory: invParsed.rows }
    const ok = maniRows.filter(r => r.ref && r.platforms)
    if (ok.length) next = { ...next, overrides: { ...next.overrides, ...Object.fromEntries(ok.map(r => [r.ref, r.platforms as Platform[]])) } }
    await saveProject(next)
    onClose()
    toast(`Imported ${repo.length} file${repo.length === 1 ? '' : 's'}${invParsed?.rows.length ? `, ${invParsed.rows.length} inventory rows` : ''}${ok.length ? `, ${ok.length} manifests` : ''}.`, { tone: 'ok' })
  }

  return (
    <Modal open={!!staged} onClose={onClose} title="Review import" wide>
      <div className="stack">
        {preview && (
          <div>
            <h3 className="h4">Repo files ({repo.length})</h3>
            <table className="vt compact"><thead><tr><th>File</th><th>Detected as</th><th className="num">Checks</th><th>Validation</th></tr></thead>
              <tbody>{preview.files.map(r => <tr key={r.path}><th scope="row" className="mono" style={{ wordBreak: 'break-all' }}>{r.path}</th><td>{KIND_LABEL[r.kind]}</td><td className="num">{r.items}</td><td><Issues issues={r.issues} /></td></tr>)}</tbody></table>
            <p className="muted small">Services found: {preview.services.map(s => s.name).join(', ') || 'none'}. {errors ? `${errors} file error${errors > 1 ? 's' : ''}; those files are imported but contribute nothing until fixed.` : ''}</p>
          </div>
        )}
        {inv && map && invParsed && (
          <div>
            <h3 className="h4">Instance inventory: {inv.path}</h3>
            <div className="row gap wrap">
              {(['service', 'instance', 'count', 'hours'] as const).map(k => (
                <label key={k} className="field"><span>{k === 'instance' ? 'Instance type column' : k === 'hours' ? 'Hours/month column' : `${k[0].toUpperCase() + k.slice(1)} column`}</span>
                  <select value={map[k]} onChange={e => setMap({ ...map, [k]: Number(e.target.value) })}><option value={-1}>{k === 'hours' ? 'Assume 730 (always on)' : k === 'count' ? 'Assume 1' : '(none)'}</option>{invParsed.header.map((h, i) => <option key={i} value={i}>{h}</option>)}</select>
                </label>
              ))}
            </div>
            <p className="small">{invParsed.rows.length} rows valid{invParsed.issues.length ? `, ${invParsed.issues.length} issues:` : '.'}</p>
            {invParsed.issues.length > 0 && <Issues issues={invParsed.issues.slice(0, 12)} />}
            {p.inventory.length > 0 && <p className="warn-t small">Replaces the current inventory ({p.inventory.length} rows).</p>}
          </div>
        )}
        {manis.length > 0 && (
          <div>
            <h3 className="h4">Manifest export ({maniRows.length} images)</h3>
            <Issues issues={maniRows.filter(r => !r.platforms).map(r => ({ line: r.line, level: 'warn' as const, message: `${r.ref || 'row'}: no platform data (inspect failed or not JSON).` }))} />
            <p className="muted small">{maniRows.filter(r => r.platforms).length} images with platform lists will override live lookups.</p>
          </div>
        )}
        {unknown.length > 0 && <p className="warn-t small">Skipped (format not recognised): {unknown.map(u => u.path).join(', ')}. See the docs for supported formats.</p>}
        <div className="row end gap">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!repo.length && !invParsed?.rows.length && !maniRows.some(r => r.platforms)} onClick={() => void commit()}>Import</button>
        </div>
      </div>
    </Modal>
  )
}

function PasteModal({ open, onClose, onAdd }: { open: boolean; onClose(): void; onAdd(p: Pending): void }) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const kind = text ? detectKind(name || 'pasted', text) : 'unknown'
  return (
    <Modal open={open} onClose={onClose} title="Paste a file">
      <form className="stack" onSubmit={e => { e.preventDefault(); onAdd({ path: name || `pasted/${kind === 'unknown' ? 'file' : kind}`, text, kind: detectKind(name || 'pasted', text) }); setText(''); setName('') }}>
        <label className="field"><span>Path (sets the service name, e.g. services/api/Dockerfile)</span><input value={name} onChange={e => setName(e.target.value)} placeholder="services/api/Dockerfile" /></label>
        <label className="field"><span>Contents</span><textarea rows={12} value={text} onChange={e => setText(e.target.value)} placeholder={'FROM python:3.12-slim\nRUN pip install numpy==2.1.0'} /></label>
        <p className="small muted">Detected: <b>{KIND_LABEL[kind]}</b></p>
        <div className="row end gap"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!text.trim()}>Review</button></div>
      </form>
    </Modal>
  )
}
