export type FileKind =
  | 'dockerfile' | 'compose' | 'k8s' | 'requirements' | 'poetry' | 'package-lock'
  | 'go-mod' | 'pom' | 'gradle' | 'cargo' | 'inventory' | 'manifests' | 'unknown'

export interface RepoFile { path: string; text: string }

/** pending = waiting on a live registry lookup. */
export type Status = 'ok' | 'warn' | 'block' | 'unknown' | 'pending'

export type Ecosystem = 'image' | 'pypi' | 'npm' | 'go' | 'maven' | 'cargo' | 'apt' | 'apk' | 'binary' | 'build' | 'k8s'

export type Lookup = 'image' | 'pypi' | 'npm'

export interface Finding {
  /** Stable across scans: service|ecosystem|name. */
  id: string
  service: string
  ecosystem: Ecosystem
  name: string
  version?: string
  file: string
  line: number
  status: Status
  title: string
  detail: string
  fix?: string
  effort: 'S' | 'M' | 'L'
  /** Set while a live check is still needed. */
  lookup?: Lookup
  /** Image role: build-only stages only matter when building on Arm. */
  role?: 'runtime' | 'build'
  /** Alpine images need musllinux wheels. */
  libc?: 'glibc' | 'musl'
  source?: string
}

export interface Service {
  name: string
  files: string[]
  language?: string
  /** Built from a Dockerfile in this repo. */
  dockerfile?: string
}

export interface FileIssue { line: number; level: 'error' | 'warn' | 'info'; message: string }
export interface FileReport { path: string; kind: FileKind; lines: number; items: number; issues: FileIssue[] }

export interface Analysis { services: Service[]; findings: Finding[]; files: FileReport[] }

export interface Platform { os: string; architecture: string; variant?: string }

export interface ImageResult { ok: boolean; platforms?: Platform[]; error?: string; source?: string }

export interface PypiFile { filename: string; packagetype: string }

export interface ServiceScore {
  name: string
  score: number
  state: 'ready' | 'needs-work' | 'blocked' | 'scanning'
  blockers: number
  warnings: number
  unknown: number
  pending: number
  ok: number
}
