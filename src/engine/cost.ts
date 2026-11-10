import { FAMILY_MAP } from './knowledge.ts'
import type { FileIssue } from './types.ts'

/** AWS us-east-1, Linux, on-demand, USD per hour for the .large size (2 vCPU). Checked 2026-11-01. */
export const PRICES_AS_OF = '2026-11-01'
export interface PriceRow { family: string; arch: 'x86' | 'arm'; large: number }
export const DEFAULT_PRICES: PriceRow[] = [
  { family: 'm5', arch: 'x86', large: 0.096 }, { family: 'm5a', arch: 'x86', large: 0.086 }, { family: 'm6i', arch: 'x86', large: 0.096 }, { family: 'm6a', arch: 'x86', large: 0.0864 }, { family: 'm7i', arch: 'x86', large: 0.1008 }, { family: 'm7a', arch: 'x86', large: 0.11592 },
  { family: 'c5', arch: 'x86', large: 0.085 }, { family: 'c5a', arch: 'x86', large: 0.077 }, { family: 'c6i', arch: 'x86', large: 0.085 }, { family: 'c6a', arch: 'x86', large: 0.0765 }, { family: 'c7i', arch: 'x86', large: 0.08925 }, { family: 'c7a', arch: 'x86', large: 0.10264 },
  { family: 'r5', arch: 'x86', large: 0.126 }, { family: 'r5a', arch: 'x86', large: 0.113 }, { family: 'r6i', arch: 'x86', large: 0.126 }, { family: 'r6a', arch: 'x86', large: 0.1134 }, { family: 'r7i', arch: 'x86', large: 0.1323 }, { family: 'r7a', arch: 'x86', large: 0.15215 },
  { family: 't3', arch: 'x86', large: 0.0832 }, { family: 't3a', arch: 'x86', large: 0.0752 },
  { family: 'm6g', arch: 'arm', large: 0.077 }, { family: 'm7g', arch: 'arm', large: 0.0816 }, { family: 'm8g', arch: 'arm', large: 0.08976 },
  { family: 'c6g', arch: 'arm', large: 0.068 }, { family: 'c7g', arch: 'arm', large: 0.0725 }, { family: 'c8g', arch: 'arm', large: 0.07976 },
  { family: 'r6g', arch: 'arm', large: 0.1008 }, { family: 'r7g', arch: 'arm', large: 0.1071 }, { family: 'r8g', arch: 'arm', large: 0.11782 },
  { family: 't4g', arch: 'arm', large: 0.0672 },
]

/** Price multiplier relative to .large. Sizes scale linearly with vCPU on AWS. */
export const SIZE_FACTOR: Record<string, number> = { medium: 0.5, large: 1, xlarge: 2, '2xlarge': 4, '4xlarge': 8, '8xlarge': 16, '12xlarge': 24, '16xlarge': 32, '24xlarge': 48, '32xlarge': 64, '48xlarge': 96, metal: 96 }

export interface InventoryRow { service: string; instance: string; count: number; hours: number; perf?: number; target?: string }

export function splitType(t: string): { family: string; size: string } | null {
  const m = t.trim().toLowerCase().match(/^([a-z]+\d+[a-z]*)\.(\w+)$/)
  return m && SIZE_FACTOR[m[2]] ? { family: m[1], size: m[2] } : null
}

export function hourly(type: string, prices: PriceRow[]): number | null {
  const t = splitType(type)
  const p = t && prices.find(r => r.family === t.family)
  return p && t ? +(p.large * SIZE_FACTOR[t.size]).toFixed(5) : null
}

export function armTarget(type: string, gen: 'g3' | 'g4'): string | null {
  const t = splitType(type)
  if (!t) return null
  const fam = FAMILY_MAP[t.family]?.[gen]
  if (!fam) return t.family.includes('g') && /\dg/.test(t.family) ? type : null
  return `${fam}.${t.size}`
}

export interface CostLine extends InventoryRow { target: string | null; x86Hourly: number | null; armHourly: number | null; armCount: number; current: number; projected: number; delta: number; breakEven: number | null; note?: string }

/**
 * perf = Arm throughput relative to the current x86 instance for this workload (1.10 means each Arm instance does 10% more work).
 * Arm count = ceil(count / perf). Break-even perf is the factor at which Arm costs the same as today.
 */
export function costLine(r: InventoryRow, prices: PriceRow[], gen: 'g3' | 'g4', globalPerf: number): CostLine {
  const perf = r.perf && r.perf > 0 ? r.perf : globalPerf
  const target = r.target || armTarget(r.instance, gen)
  const x = hourly(r.instance, prices), a = target ? hourly(target, prices) : null
  const armCount = Math.max(1, Math.ceil(r.count / perf - 1e-9))
  const current = x !== null ? x * r.count * r.hours : 0
  const projected = a !== null ? a * armCount * r.hours : 0
  const ok = x !== null && a !== null
  return {
    ...r, target, x86Hourly: x, armHourly: a, armCount,
    current: ok ? round2(current) : 0, projected: ok ? round2(projected) : 0, delta: ok ? round2(projected - current) : 0,
    breakEven: ok ? +(a! / x!).toFixed(3) : null,
    note: x === null ? `No price for ${r.instance}; add its family to the price table.` : a === null ? (target ? `No price for ${target}.` : 'No Arm equivalent mapped for this family.') : undefined,
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function costSummary(lines: CostLine[]) {
  const current = round2(lines.reduce((s, l) => s + l.current, 0))
  const projected = round2(lines.reduce((s, l) => s + l.projected, 0))
  return { current, projected, delta: round2(projected - current), pct: current ? (projected - current) / current : 0 }
}

// ---------- CSV ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') q = false
      else cell += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

export const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
export const toCsv = (rows: unknown[][]) => rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'

export interface ColumnMap { service: number; instance: number; count: number; hours: number }

export function guessColumns(header: string[]): ColumnMap {
  const find = (re: RegExp) => header.findIndex(h => re.test(h.trim().toLowerCase()))
  return { service: find(/service|workload|app|node.?group|name/), instance: find(/instance|type|sku/), count: find(/count|qty|quantity|nodes|instances|desired/), hours: find(/hours/) }
}

export function parseInventory(text: string, map?: ColumnMap): { rows: InventoryRow[]; issues: FileIssue[]; header: string[]; map: ColumnMap } {
  const all = parseCsv(text)
  const header = all[0] ?? []
  const m = map ?? guessColumns(header)
  const issues: FileIssue[] = []
  const rows: InventoryRow[] = []
  if (m.instance < 0) issues.push({ line: 1, level: 'error', message: 'No instance type column. Map one before importing.' })
  else all.slice(1).forEach((r, i) => {
    const line = i + 2
    const instance = (r[m.instance] ?? '').trim().toLowerCase()
    if (!splitType(instance)) { issues.push({ line, level: 'error', message: `"${instance}" is not an EC2 instance type like c5a.2xlarge.` }); return }
    const count = m.count >= 0 ? Number(r[m.count]) : 1
    if (!Number.isFinite(count) || count < 0) { issues.push({ line, level: 'error', message: `Count "${r[m.count]}" is not a number.` }); return }
    const hoursRaw = m.hours >= 0 ? Number(r[m.hours]) : 730
    const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 730
    if (m.hours >= 0 && hours !== hoursRaw) issues.push({ line, level: 'warn', message: 'Hours missing; assumed 730 (always on).' })
    rows.push({ service: m.service >= 0 ? (r[m.service] ?? '').trim() || `row ${line}` : `row ${line}`, instance, count, hours })
  })
  return { rows, issues, header, map: m }
}
