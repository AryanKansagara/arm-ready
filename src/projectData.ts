import { useEffect, useState } from 'react'
import { repoScore, scoreServices } from './engine/classify.ts'
import { analyze } from './engine/parse.ts'
import { resolveFindings } from './engine/resolve.ts'
import { SAMPLE_FILES, SAMPLE_INVENTORY, SAMPLE_NAME, sampleHistory } from './engine/sample.ts'
import { parseInventory } from './engine/cost.ts'
import type { Finding, RepoFile } from './engine/types.ts'
import { liveLookups } from './live.ts'
import { blankProject, getData, getProject, getProjects, putData, saveProject, useProjects, uuid, type Project, type Snapshot } from './store.ts'

export function snapshotOf(services: string[], findings: Finding[], label: string, at = Date.now()): Snapshot {
  const scores = scoreServices(services, findings)
  const items: Snapshot['items'] = {}
  for (const f of findings) if (f.status !== 'ok') items[f.id] = { s: f.status, t: f.title, svc: f.service, n: f.name }
  return { id: uuid(), label, createdAt: at, score: repoScore(scores), services: scores, items }
}

export interface ScanProgress { findings: Finding[]; done: number; total: number }

/** Parses the repo files, runs the live checks, saves results and a history snapshot. */
export async function runScan(id: string, onProgress?: (p: ScanProgress) => void, signal?: AbortSignal): Promise<Project | null> {
  const files = (await getData(id)) ?? []
  const a = analyze(files)
  let cur = a.findings
  const total = cur.filter(f => f.status === 'pending').length
  onProgress?.({ findings: cur, done: 0, total })
  const p0 = getProject(id)
  const resolved = await resolveFindings(a.findings, liveLookups, {
    overrides: p0?.overrides, signal,
    onUpdate: (f, done) => { cur = cur.map(x => x.id === f.id ? f : x); onProgress?.({ findings: cur, done, total }) },
  })
  if (signal?.aborted) return null
  const p = getProject(id)
  if (!p) return null
  const services = a.services
  const snap = snapshotOf(services.map(s => s.name), resolved, `Scan of ${files.length} file${files.length === 1 ? '' : 's'}`)
  return saveProject({ ...p, files: a.files, services, findings: resolved, scannedAt: Date.now(), snapshots: [...p.snapshots, snap].slice(-60), dataMissing: false })
}

export async function createSampleProject(): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === 'shopfront')
  if (existing) return existing
  const p = { ...blankProject(SAMPLE_NAME), sampleId: 'shopfront', inventory: parseInventory(SAMPLE_INVENTORY).rows, registry: 'ghcr.io/shopfront-example' }
  const a = analyze(SAMPLE_FILES)
  await putData(p.id, SAMPLE_FILES)
  return saveProject({ ...p, files: a.files, services: a.services })
}

/** Backfills the sample's earlier commits as history. Uses the same live lookups, which are cached by then. */
export async function seedSampleHistory(id: string) {
  const snaps: Snapshot[] = []
  for (const h of sampleHistory()) {
    const a = analyze(h.files)
    const r = await resolveFindings(a.findings, liveLookups)
    snaps.push(snapshotOf(a.services.map(s => s.name), r, h.label, Date.parse(h.at)))
  }
  const p = getProject(id)
  if (p) await saveProject({ ...p, snapshots: [...snaps, ...p.snapshots] })
}

export function createBlankProject(name: string) { return saveProject(blankProject(name)) }

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [files, setFiles] = useState<RepoFile[] | null>(null)
  const key = project ? project.files.map(f => f.path + f.lines).join('|') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    void getData(project.id).then(d => { if (live) setFiles(d ?? []) })
    return () => { live = false }
  }, [project?.id, key])
  return { loading: list === null || (!!project && files === null), project, files: files ?? [] }
}
