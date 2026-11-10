import { useState } from 'react'
import { BASE_DEFAULTS, getDefaults, resetDefaults, setDefaults, type Defaults } from './store.ts'
import { setTheme, toast, useDark } from './ui.tsx'
import { useSync } from './sync.ts'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const s = useSync()
  const save = (patch: Partial<Defaults>) => { const n = { ...d, ...patch }; setD(n); setDefaults(n) }
  return (
    <section className="page narrow">
      <p className="eyebrow">Settings</p>
      <h1>Settings</h1>
      <div className="card pad stack">
        <h2 className="h4">Defaults for new repos</h2>
        <div className="row gap wrap">
          <label className="field"><span>Graviton generation for costing</span><select value={d.gen} onChange={e => save({ gen: e.target.value as Defaults['gen'] })}><option value="g3">Graviton3 (m7g, c7g, r7g)</option><option value="g4">Graviton4 (m8g, c8g, r8g)</option></select></label>
          <label className="field"><span>Arm performance factor</span><input type="number" min={0.5} max={2} step={0.05} value={d.perf} onChange={e => save({ perf: Math.min(2, Math.max(0.5, +e.target.value || 1)) })} /></label>
        </div>
        <label className="field"><span>Image registry prefix for generated CI</span><input value={d.registry} onChange={e => save({ registry: e.target.value })} placeholder="ghcr.io/your-org" /></label>
        <div className="row gap wrap">
          <label className="field"><span>Arm node taint key (blank if none)</span><input value={d.taintKey} onChange={e => save({ taintKey: e.target.value.trim() })} placeholder="kubernetes.io/arch" /></label>
          <label className="field"><span>Taint value</span><input value={d.taintValue} onChange={e => save({ taintValue: e.target.value.trim() })} /></label>
          <label className="field"><span>Patch mode</span><select value={d.mode} onChange={e => save({ mode: e.target.value as Defaults['mode'] })}><option value="required">Require arm64 (nodeSelector)</option><option value="preferred">Prefer arm64 (affinity)</option></select></label>
        </div>
        <p className="muted small">Saved as you type. Existing repos keep their own settings.</p>
      </div>
      <div className="card pad stack">
        <h2 className="h4">Appearance</h2>
        <div className="seg" role="group" aria-label="Theme">
          <button type="button" aria-pressed={dark} onClick={() => setTheme('dark')}>Dark</button>
          <button type="button" aria-pressed={!dark} onClick={() => setTheme('light')}>Light</button>
        </div>
      </div>
      <div className="card pad stack">
        <h2 className="h4">Keyboard</h2>
        <p className="small" style={{ margin: 0 }}><kbd>1</kbd>–<kbd>6</kbd> switch repo tabs · <kbd>R</kbd> re-scan · <kbd>/</kbd> search the worklist · <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> undo the last delete</p>
      </div>
      <div className="card pad stack">
        <h2 className="h4">Data and sync</h2>
        <p className="muted small">{s.user ? `Signed in as ${s.user.email}. Use the account menu to sync, export, or delete cloud data.` : 'Signed out. Everything is stored in this browser (IndexedDB). Sign in from the account menu to sync across devices.'} Live checks send image references to this site's lookup function (for registries without CORS) and package names straight to PyPI and npm. File contents never leave the browser.</p>
        <button type="button" className="btn ghost sm" onClick={() => { const prev = d; resetDefaults(); setD(BASE_DEFAULTS); toast('Defaults restored.', { undo: () => { setDefaults(prev); setD(prev) } }) }}>Restore default settings</button>
      </div>
    </section>
  )
}
