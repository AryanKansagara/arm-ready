import { EC2_PRICES, EC2_PRICES_AS_OF } from './ec2Prices.ts'
import type { FileIssue } from './types.ts'

/** Instance type -> USD per hour, Linux on-demand, for one region. The bundled table is us-east-1. */
export type PriceTable = Record<string, number>
export const PRICES_AS_OF = EC2_PRICES_AS_OF
export { EC2_PRICES }

/** Editable per-family prices for the .large size; other sizes keep the ratio they have in the AWS table. */
export interface PriceRow { family: string; arch: 'x86' | 'arm'; large: number }
const FAMILIES: [PriceRow['arch'], string[]][] = [
  ['x86', ['m5', 'm5a', 'm6i', 'm6a', 'm7i', 'm7a', 'c5', 'c5a', 'c6i', 'c6a', 'c7i', 'c7a', 'r5', 'r5a', 'r6i', 'r6a', 'r7i', 'r7a', 't3', 't3a']],
  ['arm', ['m6g', 'm7g', 'm8g', 'c6g', 'c7g', 'c8g', 'r6g', 'r7g', 'r8g', 't4g']],
]
export const defaultPrices = (table: PriceTable = EC2_PRICES): PriceRow[] =>
  FAMILIES.flatMap(([arch, fams]) => fams.filter(f => table[f + '.large']).map(family => ({ family, arch, large: table[family + '.large'] })))
export const DEFAULT_PRICES: PriceRow[] = defaultPrices()

/** vCPU relative to .large. Used to pick the next size up when the Arm family lacks one, and to price types missing from the table. */
export const SIZE_FACTOR: Record<string, number> = { nano: 0.125, micro: 0.25, small: 0.5, medium: 0.5, large: 1, xlarge: 2, '2xlarge': 4, '3xlarge': 6, '4xlarge': 8, '6xlarge': 12, '8xlarge': 16, '9xlarge': 18, '10xlarge': 20, '12xlarge': 24, '16xlarge': 32, '18xlarge': 36, '24xlarge': 48, '32xlarge': 64, '48xlarge': 96, metal: 96 }

export interface InventoryRow { service: string; instance: string; count: number; hours: number; perf?: number; target?: string }

export function splitType(t: string): { family: string; size: string } | null {
  const m = t.trim().toLowerCase().match(/^([a-z][a-z0-9-]*\d[a-z0-9-]*)\.([a-z0-9-]+)$/)
  return m && (SIZE_FACTOR[m[2]] || EC2_PRICES[`${m[1]}.${m[2]}`]) ? { family: m[1], size: m[2] } : null
}

export function hourly(type: string, prices: PriceRow[], table: PriceTable = EC2_PRICES): number | null {
  const t = splitType(type)
  if (!t) return null
  const exact = table[`${t.family}.${t.size}`], base = table[`${t.family}.large`]
  const row = prices.find(r => r.family === t.family)
  if (!row) return exact ?? null
  // The family row carries any edit (a discount, another region); the size ratio comes from AWS.
  const factor = exact && base ? exact / base : SIZE_FACTOR[t.size]
  return factor ? +(row.large * factor).toFixed(5) : null
}

/** Graviton families end their generation number with g: m7g, c7gn, r8gd, t4g, x2gd, im4gn. a1 is the first generation. */
export const isArmFamily = (family: string) => /^[a-z]+\d+g/.test(family) || family === 'a1'

export type Gen = 'g3' | 'g4' | 'g5'
const GEN_NUMBERS: Record<Gen, number[]> = { g3: [7, 6], g4: [8, 7, 6], g5: [9, 8, 7, 6] }

/**
 * The Graviton type for an x86 type: same class letter, the newest generation at or below the chosen one,
 * keeping local NVMe (d) and network (n) variants where they exist, at the same size or the next size up.
 */
export function armTarget(type: string, gen: Gen, table: PriceTable = EC2_PRICES): string | null {
  const t = splitType(type)
  if (!t) return null
  if (isArmFamily(t.family)) return type.trim().toLowerCase()
  // Only the general-purpose, compute, memory and burstable classes have a like-for-like Graviton shape.
  const m = t.family.match(/^([mcrt])(\d+)([a-z]*)(?:-flex)?$/)
  if (!m) return null
  const cls = m[1], d = m[3].includes('d'), n = m[3].includes('n')
  const variants = [...new Set([(d ? 'd' : '') + (n ? 'n' : ''), d ? 'd' : '', n ? 'n' : '', ''])]
  const families = cls === 't' ? ['t4g'] : GEN_NUMBERS[gen].flatMap(g => variants.map(v => `${cls}${g}g${v}`))
  // Price within a family tracks vCPU, which also sizes metal (m5.metal is a 24xlarge, c5.metal too).
  const own = table[`${t.family}.${t.size}`], ownLarge = table[`${t.family}.large`]
  const want = own && ownLarge ? Math.round(own / ownLarge * 8) / 8 : SIZE_FACTOR[t.size]
  for (const fam of families) {
    if (t.size !== 'metal' && table[`${fam}.${t.size}`]) return `${fam}.${t.size}`
    if (!want) continue
    const up = Object.keys(table).filter(k => k.startsWith(fam + '.')).map(k => k.slice(fam.length + 1)).filter(s => s !== 'metal' && SIZE_FACTOR[s] >= want).sort((a, b) => SIZE_FACTOR[a] - SIZE_FACTOR[b])[0]
    if (up) return `${fam}.${up}`
  }
  return null
}

export interface CostLine extends Omit<InventoryRow, "target"> { target: string | null; x86Hourly: number | null; armHourly: number | null; armCount: number; current: number; projected: number; delta: number; breakEven: number | null; note?: string }

/**
 * perf = Arm throughput relative to the current x86 instance for this workload (1.10 means each Arm instance does 10% more work).
 * Arm count = ceil(count / perf). Break-even perf is the factor at which Arm costs the same as today.
 */
export function costLine(r: InventoryRow, prices: PriceRow[], gen: Gen, globalPerf: number, table: PriceTable = EC2_PRICES): CostLine {
  const perf = r.perf && r.perf > 0 ? r.perf : globalPerf
  const target = r.target || armTarget(r.instance, gen, table)
  const x = hourly(r.instance, prices, table), a = target ? hourly(target, prices, table) : null
  const armCount = Math.max(1, Math.ceil(r.count / perf - 1e-9))
  const current = x !== null ? x * r.count * r.hours : 0
  const projected = a !== null ? a * armCount * r.hours : 0
  const ok = x !== null && a !== null
  return {
    ...r, target, x86Hourly: x, armHourly: a, armCount,
    current: ok ? round2(current) : 0, projected: ok ? round2(projected) : 0, delta: ok ? round2(projected - current) : 0,
    breakEven: ok ? +(a! / x!).toFixed(3) : null,
    note: x === null ? `No price for ${r.instance} in this region.` : a === null ? (target ? `No price for ${target}.` : 'No like-for-like Graviton type; enter an Arm type for this row.') : undefined,
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
