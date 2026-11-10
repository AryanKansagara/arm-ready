import { cliExportScript } from './engine/actions.ts'
import { PRICES_AS_OF } from './engine/cost.ts'
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
          <p>Files are grouped into services by their nearest meaningful directory (<code>services/api/Dockerfile</code> and <code>services/api/requirements.txt</code> both belong to <b>api</b>). Kubernetes workloads and Compose services use their own names, so name the directory after the workload to merge them.</p>
          <h3>Dockerfiles</h3>
          <p>Any <code>Dockerfile</code>, <code>Dockerfile.*</code>, <code>*.dockerfile</code> or <code>Containerfile</code>. Multi-stage builds, <code>ARG</code> defaults and <code>--platform</code> are understood. The final stage is the runtime image; earlier stages are build-only.</p>
          <h3>Kubernetes and Helm</h3>
          <p>Raw YAML works. For Helm charts, render first so image tags are resolved:</p>
          <Code label="shell" code={`helm template my-release ./chart -f values-prod.yaml > rendered.yaml
# or from a live cluster (one file per namespace)
kubectl get deploy,sts,ds,cronjob -n shop -o yaml > live-workloads.yaml`} />
          <h3>Compose</h3>
          <p><code>docker-compose.yml</code> / <code>compose.yaml</code>. Services with a <code>build:</code> key are treated as built from this repo.</p>
          <h3>Lockfiles</h3>
          <ul>
            <li><b>Python</b>: <code>requirements.txt</code> with pins (<code>pip freeze &gt; requirements.txt</code>) or <code>poetry.lock</code>. Unpinned names are checked at their latest release.</li>
            <li><b>Node</b>: <code>package-lock.json</code> v2 or v3 (npm 7+). Regenerate an old one with <code>npm install --package-lock-only</code>. Only packages with install scripts are looked up; the rest are pure JavaScript.</li>
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
            <li><b>Dockerfile lines</b>: downloads whose URL contains <code>amd64</code>, <code>x86_64</code>, <code>x64</code> or <code>linux64</code> without an architecture variable (<code>$TARGETARCH</code>, <code>$(uname -m)</code>, <code>$(dpkg --print-architecture)</code>), hard-coded <code>GOARCH</code>, <code>--platform=linux/amd64</code>, <code>[arch=amd64]</code> apt sources, <code>x86_64-linux-gnu</code> paths, and x86 compiler flags.</li>
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
          <p>Prices: AWS us-east-1, Linux, on-demand, curated <b>{PRICES_AS_OF}</b>, stored per .large size and scaled linearly by vCPU (which matches EC2 pricing within each family). x86 families map to the same-shape Graviton family (m to m7g/m8g, c to c7g/c8g, r to r7g/r8g, t3 to t4g). All prices are editable per repo, and each row accepts a different target type.</p>
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
