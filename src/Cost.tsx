import { useMemo, useState } from 'react'
import { costLine, costSummary, DEFAULT_PRICES, parseInventory, PRICES_AS_OF, splitType, toCsv, type InventoryRow, type PriceRow } from './engine/cost.ts'
import { SAMPLE_INVENTORY } from './engine/sample.ts'
import { getProject, saveProject, type Project } from './store.ts'
import { download, Empty, fmtUsd, Link, toast } from './ui.tsx'
import { slug } from './widgets.tsx'

export default function Cost({ project: p }: { project: Project }) {
  const prices = p.prices ?? DEFAULT_PRICES
  const lines = useMemo(() => p.inventory.map(r => costLine(r, prices, p.cost.gen, p.cost.perf)), [p.inventory, prices, p.cost])
  const sum = costSummary(lines)
  const set = (patch: Partial<Project>) => void saveProject({ ...p, ...patch })
  const setRow = (i: number, patch: Partial<InventoryRow>) => set({ inventory: p.inventory.map((r, k) => k === i ? { ...r, ...patch } : r) })
  const max = Math.max(1, ...lines.flatMap(l => [l.current, l.projected]))

  if (!p.inventory.length) return (
    <Empty title="No instance inventory yet">
      <p className="muted">Import a CSV with an instance type and count per node group (EKS managed node groups, ASGs or a Cost Explorer export), or add rows by hand.</p>
      <div className="row gap center-x wrap">
        <Link href={`/app/p/${p.id}/files?import=1`} className="btn primary">Import CSV</Link>
        <button type="button" className="btn outline" onClick={() => set({ inventory: [{ service: 'nodegroup-1', instance: 'm5.xlarge', count: 3, hours: 730 }] })}>Add a row</button>
        <button type="button" className="btn ghost" onClick={() => set({ inventory: parseInventory(SAMPLE_INVENTORY).rows })}>Use example rows</button>
      </div>
    </Empty>
  )

  return (
    <div className="stack-lg">
      <div className="kpis">
        <div className="kpi card"><div className="kpi-label">x86 today</div><div className="kpi-value">{fmtUsd(sum.current)}</div><div className="kpi-sub">per month, on-demand</div></div>
        <div className="kpi card"><div className="kpi-label">On Arm</div><div className="kpi-value">{fmtUsd(sum.projected)}</div><div className="kpi-sub">{lines.reduce((n, l) => n + l.armCount, 0)} instances vs {p.inventory.reduce((n, r) => n + r.count, 0)}</div></div>
        <div className="kpi card"><div className="kpi-label">Change</div><div className={`kpi-value ${sum.delta <= 0 ? 'ok-t' : 'block-t'}`}>{sum.delta <= 0 ? '−' : '+'}{fmtUsd(Math.abs(sum.delta))}</div><div className="kpi-sub">{(sum.pct * 100).toFixed(1)}% · {fmtUsd(Math.abs(sum.delta) * 12)}/yr</div></div>
        <div className="kpi card"><div className="kpi-label">Assumptions</div>
          <div className="seg" role="group" aria-label="Graviton generation" style={{ margin: '.35rem 0' }}>
            <button type="button" aria-pressed={p.cost.gen === 'g3'} onClick={() => set({ cost: { ...p.cost, gen: 'g3' } })}>Graviton3</button>
            <button type="button" aria-pressed={p.cost.gen === 'g4'} onClick={() => set({ cost: { ...p.cost, gen: 'g4' } })}>Graviton4</button>
          </div>
          <label className="field"><span>Arm performance factor: {p.cost.perf.toFixed(2)}×</span><input type="range" min={0.7} max={1.5} step={0.05} value={p.cost.perf} onChange={e => set({ cost: { ...p.cost, perf: +e.target.value } })} /></label>
        </div>
      </div>

      <div className="banner">
        <b>Performance factor</b> = work one Arm instance does relative to the x86 instance it replaces, for <i>your</i> workload. 1.00 means same instance count. Load-test one service before trusting it: some teams report needing more instances, others fewer. <b>Break-even</b> is the factor at which Arm costs the same as today.
      </div>

      <div className="card table-card">
        <table className="vt stack-sm-table">
          <thead><tr><th>Node group / service</th><th>x86 type</th><th className="num">Count</th><th>Arm type</th><th className="num">Perf ×</th><th className="num">Arm count</th><th className="num">Today</th><th className="num">On Arm</th><th className="num">Break-even</th><th><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.service} onChange={e => setRow(i, { service: e.target.value })} aria-label="Service" style={{ width: '9rem' }} /></td>
              <td><input value={l.instance} className={splitType(l.instance) ? '' : 'error'} onChange={e => setRow(i, { instance: e.target.value.trim().toLowerCase() })} aria-label="x86 instance type" style={{ width: '8.5rem' }} /></td>
              <td className="num"><input type="number" min={0} value={l.count} onChange={e => setRow(i, { count: Math.max(0, +e.target.value || 0) })} aria-label="Count" style={{ width: '4.5rem' }} /></td>
              <td><input value={p.inventory[i].target ?? ''} placeholder={l.target ?? 'none'} onChange={e => setRow(i, { target: e.target.value.trim().toLowerCase() || undefined })} aria-label="Arm instance type" style={{ width: '8.5rem' }} /></td>
              <td className="num"><input type="number" min={0.3} max={3} step={0.05} value={p.inventory[i].perf ?? ''} placeholder={p.cost.perf.toFixed(2)} onChange={e => setRow(i, { perf: +e.target.value || undefined })} aria-label="Performance factor override" style={{ width: '4.8rem' }} /></td>
              <td className="num">{l.armCount}</td>
              <td className="num">{l.note ? '–' : fmtUsd(l.current)}</td>
              <td className="num">{l.note ? <span className="warn-t small">{l.note}</span> : <>{fmtUsd(l.projected)}<div className={`tiny ${l.delta <= 0 ? 'ok-t' : 'block-t'}`}>{l.delta <= 0 ? '−' : '+'}{fmtUsd(Math.abs(l.delta))}</div></>}</td>
              <td className="num">{l.breakEven ? `${l.breakEven.toFixed(2)}×` : '–'}</td>
              <td><button type="button" className="btn danger-ghost sm" aria-label={`Remove ${l.service}`} onClick={() => { const prev = p.inventory; set({ inventory: p.inventory.filter((_, k) => k !== i) }); toast(`Removed ${l.service}.`, { undo: () => void saveProject({ ...getProject(p.id)!, inventory: prev }) }) }}>×</button></td>
            </tr>))}
          </tbody>
        </table>
        <div className="pad row gap-sm wrap">
          <button type="button" className="btn ghost sm" onClick={() => set({ inventory: [...p.inventory, { service: `nodegroup-${p.inventory.length + 1}`, instance: 'm5.large', count: 1, hours: 730 }] })}>Add row</button>
          <button type="button" className="btn ghost sm" onClick={() => download(`${slug(p.name)}-arm-cost.csv`, toCsv([['service', 'x86_type', 'count', 'hours', 'arm_type', 'perf', 'arm_count', 'x86_monthly', 'arm_monthly', 'delta', 'break_even'], ...lines.map(l => [l.service, l.instance, l.count, l.hours, l.target ?? '', l.perf ?? p.cost.perf, l.armCount, l.current, l.projected, l.delta, l.breakEven ?? ''])]))}>Download CSV</button>
        </div>
      </div>

      <div className="card pad">
        <h2 className="h4">Monthly cost by node group</h2>
        <div className="cost-bars">
          {lines.filter(l => !l.note).map((l, i) => (
            <div key={i} className="stack-sm">
              <div className="cost-bar"><span className="small">{l.service}</span><div className="track"><i style={{ width: `${(l.current / max) * 100}%`, background: 'var(--border-strong)' }} /></div><span className="small num">{fmtUsd(l.current)} x86</span></div>
              <div className="cost-bar"><span /><div className="track"><i style={{ width: `${(l.projected / max) * 100}%`, background: l.delta <= 0 ? 'var(--tile-ok)' : 'var(--tile-block)' }} /></div><span className="small num">{fmtUsd(l.projected)} Arm</span></div>
            </div>
          ))}
        </div>
      </div>

      <PriceTable p={p} prices={prices} />
    </div>
  )
}

function PriceTable({ p, prices }: { p: Project; prices: PriceRow[] }) {
  const [open, setOpen] = useState(false)
  const setPrice = (fam: string, v: number) => void saveProject({ ...p, prices: prices.map(r => r.family === fam ? { ...r, large: v } : r) })
  return (
    <div className="card pad">
      <div className="row between wrap gap-sm">
        <div><h2 className="h4" style={{ marginBottom: '.2rem' }}>Price table</h2><p className="muted small" style={{ margin: 0 }}>AWS us-east-1, Linux, on-demand, USD/hour for the .large size; other sizes scale with vCPU. Curated {PRICES_AS_OF}{p.prices ? ', edited for this repo' : ''}. Check the EC2 pricing page for your region and any Savings Plan discount.</p></div>
        <div className="row gap-sm">
          {p.prices && <button type="button" className="btn ghost sm" onClick={() => { const prev = p.prices; void saveProject({ ...p, prices: null }); toast('Prices reset to defaults.', { undo: () => void saveProject({ ...getProject(p.id)!, prices: prev }) }) }}>Reset</button>}
          <button type="button" className="btn outline sm" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Edit prices'}</button>
        </div>
      </div>
      {open && (
        <div className="grid-2" style={{ marginTop: '1rem' }}>
          {(['x86', 'arm'] as const).map(arch => (
            <table key={arch} className="vt compact"><thead><tr><th>{arch === 'x86' ? 'x86 family' : 'Arm (Graviton) family'}</th><th className="num">$/h .large</th></tr></thead>
              <tbody>{prices.filter(r => r.arch === arch).map(r => <tr key={r.family}><th scope="row">{r.family}</th><td className="num"><input type="number" step={0.0001} min={0} value={r.large} onChange={e => setPrice(r.family, Math.max(0, +e.target.value || 0))} aria-label={`${r.family} price`} style={{ width: '6.5rem' }} /></td></tr>)}</tbody>
            </table>
          ))}
        </div>
      )}
    </div>
  )
}
