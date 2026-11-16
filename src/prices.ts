import { useEffect, useState } from 'react'
import { defaultPrices, EC2_PRICES, PRICES_AS_OF, type PriceRow, type PriceTable } from './engine/cost.ts'

// EC2 on-demand prices per region. us-east-1 ships with the app; other regions (and newer us-east-1
// prices) come from /api/prices, which reads the public AWS pricing file, and are kept for a week.
export const REGIONS: [string, string][] = [
  ['us-east-1', 'US East (N. Virginia)'], ['us-east-2', 'US East (Ohio)'], ['us-west-1', 'US West (N. California)'], ['us-west-2', 'US West (Oregon)'],
  ['ca-central-1', 'Canada (Central)'], ['sa-east-1', 'South America (São Paulo)'],
  ['eu-west-1', 'Europe (Ireland)'], ['eu-west-2', 'Europe (London)'], ['eu-west-3', 'Europe (Paris)'], ['eu-central-1', 'Europe (Frankfurt)'], ['eu-north-1', 'Europe (Stockholm)'], ['eu-south-1', 'Europe (Milan)'],
  ['ap-south-1', 'Asia Pacific (Mumbai)'], ['ap-southeast-1', 'Asia Pacific (Singapore)'], ['ap-southeast-2', 'Asia Pacific (Sydney)'], ['ap-northeast-1', 'Asia Pacific (Tokyo)'], ['ap-northeast-2', 'Asia Pacific (Seoul)'], ['ap-east-1', 'Asia Pacific (Hong Kong)'],
  ['me-south-1', 'Middle East (Bahrain)'], ['af-south-1', 'Africa (Cape Town)'],
]

export const GEN_LABEL = { g3: 'Graviton3 (7g)', g4: 'Graviton4 (8g)', g5: 'newest (9g)' } as const

export interface RegionPrices { region: string; asOf: string; prices: PriceTable; at: number }
const BUNDLED: RegionPrices = { region: 'us-east-1', asOf: PRICES_AS_OF, prices: EC2_PRICES, at: 0 }
const TTL = 7 * 86400_000
const key = (r: string) => `arm-ready.prices.${r}`

function cached(region: string): RegionPrices | null {
  try {
    const c = JSON.parse(localStorage.getItem(key(region)) ?? 'null') as RegionPrices | null
    // A cached us-east-1 table older than the bundled one is dropped.
    return c && c.prices && (region !== 'us-east-1' || c.asOf >= PRICES_AS_OF) ? c : null
  } catch { return null }
}

const inflight = new Map<string, Promise<RegionPrices | null>>()
function load(region: string): Promise<RegionPrices | null> {
  if (!inflight.has(region)) inflight.set(region, fetch(`/api/prices?region=${region}`, { signal: AbortSignal.timeout(20000) })
    .then(r => r.json())
    .then((j: { ok: boolean; asOf: string; prices: PriceTable }) => {
      if (!j.ok) return null
      const v: RegionPrices = { region, asOf: j.asOf, prices: j.prices, at: Date.now() }
      try { localStorage.setItem(key(region), JSON.stringify(v)) } catch { /* quota: keep it in memory for this visit */ }
      return v
    })
    .catch(() => null)
    .finally(() => setTimeout(() => inflight.delete(region), 60_000)))
  return inflight.get(region)!
}

/** The price table for a region. Falls back to the bundled us-east-1 table (fallback: true) until, or unless, the region loads. */
export function useRegionPrices(region = 'us-east-1'): RegionPrices & { loading: boolean; fallback: boolean } {
  const [state, setState] = useState(() => ({ v: cached(region), loading: false }))
  useEffect(() => {
    const c = cached(region)
    const fresh = c && Date.now() - c.at < TTL
    setState({ v: c, loading: !fresh })
    if (fresh) return
    let live = true
    void load(region).then(v => { if (live) setState(s => ({ v: v ?? s.v, loading: false })) })
    return () => { live = false }
  }, [region])
  const v = state.v?.region === region ? state.v : null
  if (v) return { ...v, loading: state.loading, fallback: false }
  return { ...BUNDLED, loading: state.loading, fallback: region !== 'us-east-1' }
}

export const rowsFor = (edited: PriceRow[] | null, table: PriceTable) => edited ?? defaultPrices(table)
