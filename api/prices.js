// GET /api/prices?region=eu-west-1  ->  { ok, region, asOf, source, prices: { "m7g.large": 0.0816, ... } }
// Linux on-demand USD/hour for every EC2 instance type in the region, read from the public JSON that
// backs the AWS EC2 pricing page. That file sends no CORS headers, so the browser asks this function.

export const REGIONS = {
  'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)', 'us-west-1': 'US West (N. California)', 'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada (Central)', 'sa-east-1': 'South America (Sao Paulo)',
  'eu-west-1': 'EU (Ireland)', 'eu-west-2': 'EU (London)', 'eu-west-3': 'EU (Paris)', 'eu-central-1': 'EU (Frankfurt)', 'eu-north-1': 'EU (Stockholm)', 'eu-south-1': 'EU (Milan)',
  'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-southeast-1': 'Asia Pacific (Singapore)', 'ap-southeast-2': 'Asia Pacific (Sydney)', 'ap-northeast-1': 'Asia Pacific (Tokyo)', 'ap-northeast-2': 'Asia Pacific (Seoul)', 'ap-east-1': 'Asia Pacific (Hong Kong)',
  'me-south-1': 'Middle East (Bahrain)', 'af-south-1': 'Africa (Cape Town)',
}

export const sourceUrl = name => `https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/${encodeURIComponent(name)}/Linux/index.json`

/** Reduces the AWS file to { type: hourly price }. */
export function slim(j, name) {
  const prices = {}
  for (const v of Object.values(j?.regions?.[name] ?? {})) {
    const t = v['Instance Type'], p = Number(v.price)
    if (t && p > 0) prices[t] = +p.toFixed(5)
  }
  return { asOf: String(j?.manifest?.hawkFilePublicationDate ?? '').slice(0, 10), prices }
}

export async function GET(request) {
  const region = new URL(request.url).searchParams.get('region') || 'us-east-1'
  const name = REGIONS[region]
  if (!name) return Response.json({ ok: false, error: 'Unknown region.' }, { status: 400 })
  try {
    const r = await fetch(sourceUrl(name), { signal: AbortSignal.timeout(12000) })
    if (!r.ok) throw new Error(String(r.status))
    const out = slim(await r.json(), name)
    if (Object.keys(out.prices).length < 50) throw new Error('empty')
    return Response.json({ ok: true, region, source: 'aws.amazon.com/ec2/pricing/on-demand', ...out }, { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } })
  } catch {
    return Response.json({ ok: false, error: 'AWS price list unavailable.' }, { headers: { 'Cache-Control': 'public, s-maxage=300' } })
  }
}
