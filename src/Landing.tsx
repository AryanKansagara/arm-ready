import { useEffect, useMemo, useRef, useState } from 'react'
import { scoreServices } from './engine/classify.ts'
import { analyze } from './engine/parse.ts'
import { resolveFindings } from './engine/resolve.ts'
import { SAMPLE_FILES } from './engine/sample.ts'
import type { Finding } from './engine/types.ts'
import { liveLookups } from './live.ts'
import { createSampleProject } from './projectData.ts'
import { go, Link } from './ui.tsx'
import { Tiles } from './widgets.tsx'

const HERO_SERVICES = ['api', 'web', 'worker', 'billing', 'reports-db', 'queue']

function useLiveSampleScan() {
  const base = useMemo(() => analyze(SAMPLE_FILES), [])
  const [findings, setFindings] = useState<Finding[]>(base.findings)
  const [run, setRun] = useState(0)
  const [state, setState] = useState<'scanning' | 'done'>('scanning')
  const total = base.findings.filter(f => f.status === 'pending').length
  const [done, setDone] = useState(0)
  useEffect(() => {
    const ac = new AbortController()
    setFindings(base.findings); setDone(0); setState('scanning')
    // Results are queued and released at a readable pace; the verdicts themselves come from live registries.
    const queue: Finding[] = []
    let t: ReturnType<typeof setInterval> | undefined
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    let finished = false
    const drain = () => {
      const f = queue.shift()
      if (f) { setFindings(cur => cur.map(x => x.id === f.id ? f : x)); setDone(d => d + 1) }
      else if (finished) { clearInterval(t); setState('done') }
    }
    t = setInterval(drain, reduced ? 10 : 140)
    void resolveFindings(base.findings, liveLookups, { concurrency: 4, signal: ac.signal, onUpdate: f => queue.push(f) }).then(() => { finished = true })
    return () => { ac.abort(); clearInterval(t) }
  }, [run, base])
  return { services: base.services, findings, total, done, state, replay: () => setRun(r => r + 1) }
}

export function Landing() {
  const scan = useLiveSampleScan()
  const scores = scoreServices(HERO_SERVICES, scan.findings)
  const shown = HERO_SERVICES.map(n => scan.services.find(s => s.name === n) ?? { name: n })
  const blockers = scan.findings.filter(f => f.status === 'block' && HERO_SERVICES.includes(f.service)).length
  const ready = scores.filter(s => s.state === 'ready').length
  const openSample = async (tab = '') => { const p = await createSampleProject(); go(`/app/p/${p.id}${tab}?scan=1`) }
  const pct = scan.total ? Math.round((scan.done / scan.total) * 100) : 100
  const ref = useRef<HTMLDivElement>(null)

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <p className="eyebrow">arm64 migration readiness</p>
            <h1>Know what breaks on <em>Graviton</em> before your pods do.</h1>
            <p className="lede">Drop in your Dockerfiles, Kubernetes manifests and lockfiles. Arm Ready checks every base image, downloaded binary and native package against live registries, then writes the multi-arch CI, the node patches and the cost case.</p>
            <div className="row gap wrap">
              <button type="button" className="btn primary lg" onClick={() => void openSample()}>Open the sample scan</button>
              <Link href="/app?import=1" className="btn ghost lg">Scan your repo</Link>
            </div>
            <div className="hero-meta"><span><b>Docker Hub, GHCR, Quay, MCR, GCR</b> manifest lists</span><span><b>PyPI</b> wheels</span><span><b>npm</b> native addons</span><span>Go, Java JNI, Rust</span></div>
          </div>
          <div className="scanner" ref={ref} aria-live="polite">
            <div className="scanner-head">
              <div><strong>shopfront</strong> <span className="badge synthetic">Synthetic repo</span></div>
              <span>{scan.state === 'scanning' ? `Live scan ${scan.done}/${scan.total}` : `${ready} of ${shown.length} ready · ${blockers} blockers`}</span>
            </div>
            <div className="scan-bar"><i style={{ width: `${pct}%` }} /></div>
            <Tiles services={shown} findings={scan.findings} scores={scores} onOpen={() => void openSample('/worklist')} />
            <div className="legend">
              <span><i style={{ background: 'var(--tile-pending)' }} />checking</span>
              <span><i style={{ background: 'var(--tile-ok)' }} />arm64 ready</span>
              <span><i style={{ background: 'var(--tile-block)' }} />blocker</span>
              <span><i style={{ background: 'var(--lavender)' }} />unverified</span>
              {scan.state === 'done' && <button type="button" className="linkish" style={{ color: 'var(--lavender)', marginLeft: 'auto' }} onClick={scan.replay}>Replay scan</button>}
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="container">
          <p className="eyebrow">Why this exists</p>
          <h2>"Is it still cheaper?" is the second question. The first is "what breaks?"</h2>
          <p className="muted" style={{ maxWidth: 760 }}>Paraphrased from platform engineers on r/devops and r/kubernetes planning x86 to Graviton moves on EKS.</p>
          <div className="quotes">
            <figure className="quote"><blockquote>Before anything else, test that every third-party image you run actually supports arm.</blockquote><cite>r/devops, moving c5a to c8g on EKS</cite></figure>
            <figure className="quote"><blockquote>Emulated QEMU builds tanked our CI times. Native arm runners fixed it.</blockquote><cite>r/kubernetes, same thread</cite></figure>
            <figure className="quote"><blockquote>We had to add instances to hold performance, so check whether it is still cheaper for your workload.</blockquote><cite>r/devops, Graviton experiences</cite></figure>
          </div>
        </div>
      </section>

      <section className="band alt">
        <div className="container">
          <p className="eyebrow">How it works</p>
          <h2>From a pile of build files to a migration plan</h2>
          <ol className="steps">
            <li><h3>Import</h3><p>Dockerfiles, Compose, rendered Helm/K8s YAML, requirements.txt, poetry.lock, package-lock.json, go.mod, pom.xml, Gradle lists, Cargo.lock. Parsed in your browser.</p></li>
            <li><h3>Check live</h3><p>Manifest lists for every image, PyPI wheel tags for every Python pin, npm metadata for every install script. Curated notes for cgo, JNI and known offenders.</p></li>
            <li><h3>Fix</h3><p>A worklist with file and line, the exact fix and effort. Multi-arch buildx workflow on native arm runners, and nodeSelector patches.</p></li>
            <li><h3>Cost and track</h3><p>Your instance inventory against dated on-demand prices with a performance factor and break-even. Re-scan each sprint and watch the trend.</p></li>
          </ol>
        </div>
      </section>

      <section className="band">
        <div className="container">
          <div className="bento">
            <div className="bento-item wide dark">
              <h3>Catches what a manifest check misses</h3>
              <p>An arm64 base image does not help if line 7 curls an amd64 tarball, GOARCH is hard-coded, or LD_LIBRARY_PATH points at x86_64-linux-gnu.</p>
              <pre>{`services/api/Dockerfile:7   Downloads an amd64 binary
services/worker/Dockerfile:7  Go build hard-codes GOARCH
billing pom.xml:12   netty epoll classifier linux-x86_64`}</pre>
            </div>
            <div className="bento-item wide">
              <h3>Wheels, musl and native addons</h3>
              <p>mysqlclient has no aarch64 wheel, so pip compiles it. A manylinux wheel does not help on Alpine. node-sass will never build. Each verdict cites the registry data it came from.</p>
            </div>
            <div className="bento-item">
              <h3>CI without the QEMU tax</h3>
              <p>Generated GitHub Actions matrix on ubuntu-24.04-arm runners, pushed by digest and merged with imagetools.</p>
            </div>
            <div className="bento-item">
              <h3>Honest cost math</h3>
              <p>c5a.2xlarge to c8g.2xlarge is not cheaper per hour. Arm Ready shows the break-even performance factor so you can decide with numbers.</p>
            </div>
            <div className="bento-item">
              <h3>Local first</h3>
              <p>No account needed. Sign in only if you want repos and scan history synced across machines.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="container">
        <div className="cta-band">
          <h2>Scan the synthetic repo, then yours.</h2>
          <p>Five services, one amd64-only vendor database, a Node native addon and a JNI classifier. See what it finds in under a minute.</p>
          <div className="row gap center-x wrap"><button type="button" className="btn lg" onClick={() => void openSample()}>Open the sample scan</button><Link href="/docs" className="btn lg" style={{ background: 'transparent', color: '#fff' }}>Read the docs</Link></div>
        </div>
      </section>
    </>
  )
}
