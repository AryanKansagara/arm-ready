// The Vercel functions are plain JS modules; the engine tests import their pure helpers.
declare module '*/api/prices.js' {
  export const REGIONS: Record<string, string>
  export function slim(file: unknown, name: string): { asOf: string; prices: Record<string, number> }
  export function GET(request: Request): Promise<Response>
}
declare module '*/api/manifest.js' {
  export function parseRef(raw: string): { host: string; repo: string; ref: string; tag: string | null } | null
  export function GET(request: Request): Promise<Response>
}
