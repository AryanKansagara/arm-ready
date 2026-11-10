import { useState } from 'react'
import { buildxCli, buildxWorkflow, cliExportScript, k8sPatches, workloadKinds, worklistCsv } from './engine/actions.ts'
import { detectKind } from './engine/parse.ts'
import type { RepoFile } from './engine/types.ts'
import { saveProject, type Project } from './store.ts'
import { Code, download, Link } from './ui.tsx'
import { slug } from './widgets.tsx'

export default function Actions({ project: p, files }: { project: Project; files: RepoFile[] }) {
  const [runner, setRunner] = useState<'native' | 'qemu'>('native')
  const findings = p.findings ?? []
  const images = findings.filter(f => f.ecosystem === 'image' && f.status !== 'ok' && !/Built from this repo/.test(f.title)).map(f => f.name)
  const allImages = [...new Set(findings.filter(f => f.ecosystem === 'image' && f.title !== 'Built from this repo').map(f => f.name))]
  const [allRefs, setAllRefs] = useState(false)
  const k8sText = files.filter(f => detectKind(f.path, f.text) === 'k8s').map(f => f.text).join('\n---\n')
  const kinds = workloadKinds(k8sText)
  const blocked = new Set(findings.filter(f => f.status === 'block').map(f => f.service))
  const [pick, setPick] = useState<Set<string> | null>(null)
  const chosen = pick ?? new Set(kinds.filter(k => !blocked.has(k.name)).map(k => k.name))
  const patches = k8sPatches(kinds.filter(k => chosen.has(k.name)), p.k8s)
  const setK8s = (patch: Partial<Project['k8s']>) => void saveProject({ ...p, k8s: { ...p.k8s, ...patch } })

  return (
    <div className="stack-lg">
      <div className="card pad row between wrap gap">
        <div><h2 className="h4" style={{ marginBottom: '.2rem' }}>Hand-offs</h2><p className="muted small" style={{ margin: 0 }}>Worklist for the tracker, a printable report for the change review.</p></div>
        <div className="row gap-sm wrap">
          <button type="button" className="btn primary sm" onClick={() => download(`${slug(p.name)}-arm64-worklist.csv`, worklistCsv(findings, p.work))}>Worklist CSV</button>
          <Link href={`/app/p/${p.id}/report`} className="btn outline sm">Printable report</Link>
        </div>
      </div>

      <div className="card pad stack">
        <div className="row between wrap gap">
          <div><h2 className="h4" style={{ marginBottom: '.2rem' }}>Multi-arch CI</h2><p className="muted small" style={{ margin: 0 }}>Builds every Dockerfile found ({p.services.filter(s => s.dockerfile).length}) for linux/amd64 and linux/arm64 and pushes one tag per service.</p></div>
          <div className="seg" role="group" aria-label="Runner type">
            <button type="button" aria-pressed={runner === 'native'} onClick={() => setRunner('native')}>Native arm runners</button>
            <button type="button" aria-pressed={runner === 'qemu'} onClick={() => setRunner('qemu')}>QEMU</button>
          </div>
        </div>
        <label className="field" style={{ maxWidth: 420 }}><span>Image registry prefix</span><input value={p.registry} onChange={e => void saveProject({ ...p, registry: e.target.value })} placeholder="ghcr.io/your-org" /></label>
        <p className="small muted">{runner === 'native' ? 'Each platform builds on its own CPU (ubuntu-24.04-arm is free for public repos; private repos need a paid plan or self-hosted Graviton runners). Digests are merged into one manifest list.' : 'One job, arm64 emulated. Fine for small images; slow when the build compiles native code (wheels, node-gyp, cgo).'}</p>
        <Code label=".github/workflows/multi-arch.yml" code={buildxWorkflow({ registry: p.registry, services: p.services, runner })} />
        <details><summary className="small">Laptop one-off with docker buildx</summary><Code label="shell" code={buildxCli(p.services, p.registry)} /></details>
      </div>

      <div className="card pad stack" id="k8s">
        <h2 className="h4">Kubernetes node patches</h2>
        {kinds.length === 0 ? <p className="muted small">No Deployments, StatefulSets or DaemonSets in the imported YAML. Import rendered manifests (helm template ... &gt; rendered.yaml) to generate patches.</p> : <>
          <div className="row gap wrap">
            <div className="seg" role="group" aria-label="Scheduling mode">
              <button type="button" aria-pressed={p.k8s.mode === 'required'} onClick={() => setK8s({ mode: 'required' })}>Require arm64</button>
              <button type="button" aria-pressed={p.k8s.mode === 'preferred'} onClick={() => setK8s({ mode: 'preferred' })}>Prefer arm64 (canary)</button>
            </div>
            <label className="field inline"><span>Taint key</span><input className="short" style={{ width: '9rem' }} value={p.k8s.taintKey} placeholder="none" onChange={e => setK8s({ taintKey: e.target.value.trim() })} /></label>
            {p.k8s.taintKey && <label className="field inline"><span>value</span><input className="short" value={p.k8s.taintValue} onChange={e => setK8s({ taintValue: e.target.value.trim() })} /></label>}
          </div>
          <fieldset className="row gap wrap" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted" style={{ marginBottom: '.4rem' }}>Workloads to move (blocked services are unticked by default)</legend>
            {kinds.map(k => <label key={k.name} className="row gap-sm small"><input type="checkbox" checked={chosen.has(k.name)} onChange={e => { const s = new Set(chosen); if (e.target.checked) s.add(k.name); else s.delete(k.name); setPick(s) }} />{k.name} <span className="muted">({k.kind}{blocked.has(k.name) ? ', blocked' : ''})</span></label>)}
          </fieldset>
          {patches.map(f => <Code key={f.file} label={f.file} code={f.text} />)}
          <div><button type="button" className="btn outline sm" onClick={() => download(`${slug(p.name)}-arm64-patches.yaml`, patches.map(f => `# ${f.file}\n${f.text}`).join('---\n'), 'text/yaml')}>Download all patches</button></div>
        </>}
      </div>

      <div className="card pad stack">
        <h2 className="h4">Verify images from your machine</h2>
        <p className="muted small">For private registries, rate limits, or images the browser could not check. Run it where docker can pull, then import the .jsonl on the Files tab.</p>
        <label className="row gap-sm small"><input type="checkbox" checked={allRefs} onChange={e => setAllRefs(e.target.checked)} /> Include every third-party image ({allImages.length}), not only the {images.length} unresolved or failing</label>
        <Code label="arm-ready-manifests.sh" code={cliExportScript(allRefs ? allImages : images.length ? images : allImages)} />
      </div>
    </div>
  )
}
