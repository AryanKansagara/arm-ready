import { cliExportScript } from './engine/actions.ts'
import { EC2_PRICES, PRICES_AS_OF } from './engine/cost.ts'
import { Code, Link } from './ui.tsx'

const SECTIONS = [['upload', 'What to upload'], ['inventory', 'Instance inventory'], ['checks', 'How checks work'], ['offline', 'Private registries'], ['scores', 'Scores'], ['cost', 'Cost model'], ['ci', 'CI and rollout'], ['privacy', 'Privacy and sync']] as const

export default function Docs() {
  return (
    <section className="page">
      <p className="eyebrow">Docs</p>
      <h1>Getting your repo into Arm Ready</h1>
      <p className="muted" style={{ maxWidth: 760 }}>Everything is parsed in the browser. Drop the files below (or a whole folder; node_modules, .git, vendor and target are skipped) on a repo's Files tab.</p>
      <div className="docs">
        <nav className="docs-nav" aria-label="Docs sections">{SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`}>{l}</a>)}</nav>
        <div className="docs-body">
          <h2 id="upload">What to upload</h2>
          <p>Files are grouped into services by their nearest meaningful directory (<code>services/api/Dockerfile</code> and <code>services/api/requirements.txt</code> both belong to <b>api</b>; container directories such as <code>src</code>, <code>docker</code> or <code>main</code> are skipped, and a lockfile below a Dockerfile's directory joins that service). Kubernetes workloads and Compose services use their own names, so name the directory after the workload to merge them.</p>
          <h3>Dockerfiles</h3>
          <p>Any <code>Dockerfile</code>, <code>Dockerfile.*</code>, <code>*.dockerfile</code> or <code>Containerfile</code>. Multi-stage builds, <code>ARG</code> defaults and <code>--platform</code> are understood. The final stage is the runtime image; earlier stages are build-only.</p>
          <h3>Kubernetes and Helm</h3>
          <p>Raw YAML works. For Helm charts, render first so image tags are resolved:</p>
          <Code label="shell" code={`helm template my-release ./chart -f values-prod.yaml > rendered.yaml
# or from a live cluster (one file per namespace)
kubectl get deploy,sts,ds,cronjob -n shop -o yaml > live-workloads.yaml`} />
          <h3>Compose</h3>
          <p><code>docker-compose.yml</code> / <code>compose.yaml</code>. Services with a <code>build:</code> key are treated as built from this repo. YAML anchors merged with <code>&lt;&lt;: *name</code> are followed for <code>image</code> and <code>build</code>, and <code>{'${VAR:-default}'}</code> uses the default. An image that is only a variable (<code>$APP_IMAGE</code> from an <code>.env</code> file) shows as unverified.</p>
          <h3>Lockfiles</h3>
          <ul>
            <li><b>Python</b>: <code>requirements.txt</code> with pins (<code>pip freeze &gt; requirements.txt</code>) or <code>poetry.lock</code>. Unpinned names are checked at their latest release.</li>
            <li><b>Node</b>: <code>package-lock.json</code> v2 or v3 (npm 7+). Regenerate an old one with <code>npm install --package-lock-only</code>. Only packages with install scripts are looked up; the rest are pure JavaScript.</li>
            <li><b>Yarn</b>: <code>yarn.lock</code> from Yarn 1 (Classic) and from Yarn 2 and later (Berry, lockfile metadata version 4 to 10). <b>pnpm</b>: <code>pnpm-lock.yaml</code> with <code>lockfileVersion</code> 9.x (pnpm 9 and later) or 6.x (pnpm 8). Other versions are reported as an error. These lockfiles do not say which packages run install scripts (only pnpm 8 marks some with <code>requiresBuild</code>), so up to 100 packages per scan are looked up on npm, those that depend on a native-build helper such as <code>node-gyp</code>, <code>nan</code> or <code>bindings</code> first, and the rest are listed as "not checked" instead of being called pure. Aliases resolve to the real package, workspace, link and file entries are skipped, and git or URL dependencies are listed as unknown. Versions come from the lockfile, never from <code>package.json</code> ranges, and <code>bun.lock</code> is not read.</li>
            <li><b>Go</b>: <code>go.mod</code>.</li>
            <li><b>Java</b>: <code>pom.xml</code>, <code>build.gradle(.kts)</code>, or a dependency list saved as <code>gradle-deps.txt</code>:
              <Code label="shell" code={`./gradlew :app:dependencies --configuration runtimeClasspath > gradle-deps.txt
mvn -q dependency:list -DoutputFile=maven-deps.txt   # or just upload pom.xml`} /></li>
            <li><b>Rust</b>: <code>Cargo.lock</code>.</li>
          </ul>

          <h2 id="inventory">Instance inventory (optional, for costing)</h2>
          <p>A CSV with an instance type column and, ideally, a count and a service or node group name. Columns are matched by name and can be re-mapped on import; rows with unknown instance types are reported by line number. Export from AWS:</p>
          <Code label="shell" code={`# Running EC2 instances grouped by EKS node group
aws ec2 describe-instances --filters Name=instance-state-name,Values=running \\
  --query 'Reservations[].Instances[].[Tags[?Key==\`eks:nodegroup-name\`]|[0].Value, InstanceType]' \\
  --output text | sort | uniq -c \\
  | awk 'BEGIN{print "service,instance_type,count"} {print $2","$3","$1}' > inventory.csv`} />
          <p>Or by hand: <code>service,instance_type,count,hours_per_month</code>. Hours default to 730 (always on).</p>

          <h2 id="checks">How checks work</h2>
          <ul>
            <li><b>Container images</b>: the manifest list (OCI index) is fetched from the registry and its platforms read; single-platform images are resolved through their config blob. Docker Hub uses the Hub tags API (no pull rate limit). GHCR, Quay, MCR, GCR, ECR Public and other public registries use the anonymous token flow. Registries do not allow browser CORS, so these requests go through this site's <code>/api/manifest</code> function; results are cached for six hours. 32-bit <code>arm/v7</code> does not count as arm64.</li>
            <li><b>Dockerfile lines</b>: downloads whose URL contains <code>amd64</code>, <code>x86_64</code>, <code>x64</code> or <code>linux64</code> without an architecture variable (<code>$TARGETARCH</code>, <code>$(uname -m)</code>, <code>$(dpkg --print-architecture)</code>), hard-coded <code>GOARCH</code>, <code>--platform=linux/amd64</code>, <code>[arch=amd64]</code> apt sources, <code>x86_64-linux-gnu</code> paths, x86 compiler flags, and Chrome for Testing installs (<code>puppeteer browsers install chrome</code>), which have no linux/arm64 build. BuildKit's own arguments (<code>BUILDPLATFORM</code>, <code>TARGETARCH</code> and friends) are never read from their <code>ARG</code> defaults, so <code>ARG TARGETARCH=amd64</code> is not a pin. A final stage written as <code>FROM base</code> is traced back to the registry image behind the alias, and a final stage that inherits <code>--platform=$BUILDPLATFORM</code> is a warning because the shipped image then follows the build host.</li>
            <li><b>OS packages</b>: apt and apk packages from the distro archives are available for arm64. A curated list flags the exceptions (Google Chrome, msodbcsql17, Intel MKL, i386 runtimes, Wine).</li>
            <li><b>Python</b>: the PyPI JSON API for the pinned version. A <code>py3-none-any</code> wheel or a <code>manylinux_*_aarch64</code> wheel passes; Alpine images need <code>musllinux_*_aarch64</code>. Source-only packages are warnings (they compile during the build); no arm64 wheel and no sdist is a blocker.</li>
            <li><b>npm</b>: registry metadata for packages with install scripts. Packages that ship a <code>linux-arm64</code> optional dependency pass; <code>prebuild-install</code>/<code>node-pre-gyp</code> loaders and <code>node-gyp</code> builds are warnings; a short curated list covers known cases (node-sass, the old grpc binding).</li>
            <li><b>Go, Java, Rust</b>: these compile or run portably, so only native pieces are flagged: cgo modules, JNI artifacts (including <code>linux-x86_64</code> classifiers and versions predating aarch64 support), and <code>*-sys</code> crates.</li>
            <li><b>Kubernetes and Compose</b>: <code>kubernetes.io/arch: amd64</code> selectors and affinities, and <code>platform: linux/amd64</code>.</li>
          </ul>

          <h2 id="offline">Private registries and failed lookups</h2>
          <p>Anything the browser could not verify shows as <b>Unverified</b>. Run this on a machine that can pull the images (after <code>docker login</code>), then import the .jsonl on the Files tab. The Actions tab generates it with your repo's image list.</p>
          <Code label="arm-ready-manifests.sh" code={cliExportScript(['your-registry.example.com/team/service:1.2.3', 'mcr.microsoft.com/mssql/server:2022-latest'])} />

          <h2 id="scores">Scores</h2>
          <p>Each service starts at 100 and loses 25 per blocker (max 75), 6 per warning (max 30) and 4 per unverified item (max 15). A service is <b>blocked</b> with any blocker, <b>needs work</b> with warnings or unverified items, and <b>ready</b> otherwise. The repo score is the mean across services. Every scan is saved to History so you can compare before and after.</p>

          <h2 id="cost">Cost model</h2>
          <p>Prices are Linux on-demand rates in USD per hour from the public price list behind the <a href="https://aws.amazon.com/ec2/pricing/on-demand/" target="_blank" rel="noreferrer">AWS EC2 On-Demand pricing page</a>. The us-east-1 table ships with the app ({Object.keys(EC2_PRICES).length} instance types, published <b>{PRICES_AS_OF}</b>); picking another of the 20 supported regions on the Cost tab loads that region's current list through <code>/api/prices</code> and keeps it for a week. Every size is priced individually, including nano to small, 3xlarge, 6xlarge, 9xlarge, 18xlarge and metal.</p>
          <p>An x86 type maps to the Graviton family with the same class letter at the chosen generation (m5, m6i, m7a to m7g, m8g or m9g; c to c7g/c8g/c9g; r to r7g/r8g/r9g; t3 to t4g). Local NVMe (<code>d</code>) and network-optimised (<code>n</code>) variants are kept where a Graviton equivalent exists (m5d to m8gd, c5n to c8gn). If the Arm family has no instance of that size, or the region does not offer that generation yet, the next size up or the previous generation is used. Each row accepts a different target type, and per-family prices can be overridden, for example with a Savings Plan rate.</p>
          <p>The <b>performance factor</b> is how much work one Arm instance does relative to the instance it replaces. Arm count = ceil(count ÷ factor). <b>Break-even</b> is the Arm-to-x86 hourly price ratio: if your measured factor beats it, Arm is cheaper. Savings Plans and Reserved Instances discount both sides similarly; spot does not, so model it separately.</p>

          <h2 id="ci">CI and rollout</h2>
          <ol>
            <li>Build multi-arch images. Prefer native arm64 runners (GitHub <code>ubuntu-24.04-arm</code>, CodeBuild on Graviton, self-hosted Graviton). QEMU emulation works but compiled steps run several times slower.</li>
            <li>Verify the tag: <code>docker buildx imagetools inspect</code> must list linux/arm64.</li>
            <li>Add an arm64 node group (or a Karpenter NodePool with <code>kubernetes.io/arch In [arm64]</code>) beside the x86 one. Optionally taint it so only patched workloads land there.</li>
            <li>Move one service at a time with the generated patches, starting with <i>prefer</i> mode as a canary. Keep vendor images without arm64 on x86.</li>
          </ol>

          <h2 id="privacy">Privacy and sync</h2>
          <p>Uploaded files stay in your browser (IndexedDB). Live checks send image references to <code>/api/manifest</code> and package names to pypi.org and registry.npmjs.org; file contents are never sent. Signing in (optional) syncs scan results, worklist status, costing and history; raw files sync only when the repo's files total under 1.5 MB. You can export everything as JSON or delete your cloud data and account from the account menu.</p>
          <p><Link href="/app" className="btn primary">Go to your repos</Link></p>
        </div>
      </div>
    </section>
  )
}
