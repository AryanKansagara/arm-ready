// Curated notes for packages whose arm64 story is not visible from registry metadata alone.
// Reviewed November 2026. Live registry checks run for everything else.

import type { Status } from './types.ts'

export interface Note { status: Status; title: string; detail: string; fix?: string; effort?: 'S' | 'M' | 'L' }

/** Debian/Ubuntu/Alpine packages that are x86-only or need care. Everything else in the main archives builds for arm64. */
export const OS_PACKAGES: Record<string, Note> = {
  'google-chrome-stable': { status: 'block', title: 'Google Chrome has no linux/arm64 build', detail: 'Google only publishes Chrome for Linux on amd64.', fix: 'Install the distro "chromium" package instead, or use the official Playwright/Puppeteer images, which ship arm64 Chromium.', effort: 'M' },
  'msodbcsql17': { status: 'block', title: 'ODBC Driver 17 for SQL Server is x64 only', detail: 'Microsoft ships arm64 builds only for ODBC Driver 18.2 and later.', fix: 'Move to msodbcsql18 (18.2+), which publishes arm64 packages for Debian and Ubuntu.', effort: 'M' },
  'msodbcsql18': { status: 'ok', title: 'ODBC Driver 18 ships arm64 (18.2+)', detail: 'Make sure the Microsoft apt source is not pinned to [arch=amd64].' },
  'libc6-i386': { status: 'block', title: '32-bit x86 runtime', detail: 'i386 compatibility libraries do not exist on arm64.', fix: 'Remove it; find out which binary needs 32-bit x86 and replace that binary.', effort: 'M' },
  'gcc-multilib': { status: 'warn', title: 'x86 multilib toolchain', detail: 'gcc-multilib targets 32-bit x86 and is not available on arm64.', fix: 'Drop it from the arm64 build, or install it only when TARGETARCH=amd64.', effort: 'S' },
  'intel-mkl': { status: 'block', title: 'Intel MKL is x86 only', detail: 'MKL uses x86 SIMD and is not built for Arm.', fix: 'Use OpenBLAS or Arm Performance Libraries (armpl) for BLAS/LAPACK on arm64.', effort: 'M' },
  'libmkl-dev': { status: 'block', title: 'Intel MKL is x86 only', detail: 'MKL uses x86 SIMD and is not built for Arm.', fix: 'Use libopenblas-dev or Arm Performance Libraries on arm64.', effort: 'M' },
  'wine': { status: 'block', title: 'Wine runs x86 Windows binaries', detail: 'Wine on arm64 cannot run x86 Windows executables without an emulator.', fix: 'Replace the Windows tool with a native Linux equivalent.', effort: 'L' },
  'nodejs': { status: 'ok', title: 'Distro Node.js builds for arm64', detail: 'Available in Debian, Ubuntu and Alpine arm64 archives.' },
}

/** npm packages whose install behaviour is well known. */
export const NPM: Record<string, Note> = {
  'node-sass': { status: 'block', title: 'node-sass has no arm64 prebuilds and is deprecated', detail: 'node-sass downloads a prebuilt binding; versions before 6 have no linux-arm64 binding and fall back to a slow, often failing node-gyp build of libsass.', fix: 'Replace with "sass" (Dart Sass, pure JS). It is a drop-in for most builds.', effort: 'S' },
  'sharp': { status: 'ok', title: 'sharp ships prebuilt linux-arm64 binaries', detail: 'Since 0.33 the binaries come from @img/sharp-linux-arm64 (glibc) and @img/sharp-linuxmusl-arm64 (Alpine).', fix: 'Run npm ci inside the arm64 build so the arm64 optional package is installed.' },
  'bcrypt': { status: 'ok', title: 'bcrypt publishes linux-arm64 prebuilds', detail: 'bcrypt 5.x downloads an arm64 binding with node-pre-gyp; it compiles from source if the download fails.', fix: 'Keep python3, make and g++ in the build stage as a fallback, or switch to bcryptjs.' },
  'grpc': { status: 'block', title: 'The native grpc package is deprecated and has no arm64 prebuilds', detail: 'grpc (the C++ binding) stopped publishing binaries in 2021.', fix: 'Move to @grpc/grpc-js, which is pure JavaScript.', effort: 'M' },
  'fsevents': { status: 'ok', title: 'macOS-only optional dependency', detail: 'Skipped on Linux; no impact.' },
  'esbuild': { status: 'ok', title: 'esbuild ships @esbuild/linux-arm64', detail: 'Prebuilt binary is picked by npm for the target platform.' },
  'canvas': { status: 'warn', title: 'node-canvas needs Cairo on arm64', detail: 'Prebuilds exist for glibc arm64 in canvas 2.11+, but Alpine needs cairo-dev, pango-dev and a source build.', fix: 'Use a Debian-based Node image, or install cairo/pango dev packages in the build stage.', effort: 'S' },
}

/** Go modules that use cgo or ship native code. */
export const GO: Record<string, Note> = {
  'github.com/mattn/go-sqlite3': { status: 'warn', title: 'cgo: needs a C toolchain for arm64', detail: 'go-sqlite3 uses cgo, so CGO_ENABLED=1 and an aarch64 C compiler are required; plain GOARCH cross-compiles fail.', fix: 'Build on a native arm64 runner, or switch to modernc.org/sqlite (pure Go).', effort: 'S' },
  'github.com/confluentinc/confluent-kafka-go': { status: 'warn', title: 'cgo with bundled librdkafka', detail: 'v2 bundles librdkafka for linux arm64 (glibc and musl), but it still needs CGO_ENABLED=1.', fix: 'Build natively on arm64 or use a cross C compiler; add -tags musl on Alpine.', effort: 'S' },
  'github.com/confluentinc/confluent-kafka-go/v2': { status: 'warn', title: 'cgo with bundled librdkafka', detail: 'Bundles librdkafka for linux arm64 (glibc and musl), but needs CGO_ENABLED=1.', fix: 'Build natively on arm64 or use a cross C compiler; add -tags musl on Alpine.', effort: 'S' },
  'github.com/DataDog/zstd': { status: 'warn', title: 'cgo zstd binding', detail: 'Compiles C sources with cgo.', fix: 'Build on arm64 natively, or use github.com/klauspost/compress/zstd (pure Go).', effort: 'S' },
  'github.com/tecbot/gorocksdb': { status: 'warn', title: 'cgo RocksDB binding', detail: 'Needs librocksdb built for arm64.', fix: 'Install librocksdb-dev from the arm64 distro archive in the build stage.', effort: 'M' },
}

export interface JavaNote extends Note { minVersion?: string }
/** Maven artifacts carrying JNI libraries, keyed by groupId:artifactId. */
export const JAVA: Record<string, JavaNote> = {
  'io.netty:netty-transport-native-epoll': { status: 'warn', title: 'Netty epoll JNI is per-architecture', detail: 'The native transport ships separate classifiers (linux-x86_64, linux-aarch_64). Without the aarch_64 one, Netty silently falls back to NIO.', fix: 'Add the linux-aarch_64 classifier alongside linux-x86_64.', effort: 'S' },
  'io.netty:netty-tcnative-boringssl-static': { status: 'ok', title: 'tcnative bundles aarch64', detail: 'The uber jar includes linux-aarch_64 natives since 2.0.31.' },
  'org.rocksdb:rocksdbjni': { status: 'ok', title: 'rocksdbjni bundles aarch64', detail: 'Linux aarch64 natives are included since 6.x.', minVersion: '6.0.0' },
  'org.xerial.snappy:snappy-java': { status: 'ok', title: 'snappy-java bundles aarch64', detail: 'Linux aarch64 natives included since 1.1.4.', minVersion: '1.1.4' },
  'org.lz4:lz4-java': { status: 'ok', title: 'lz4-java bundles aarch64', detail: 'aarch64 natives included since 1.8.0; older versions fall back to the slower pure-Java codec.', minVersion: '1.8.0' },
  'com.github.luben:zstd-jni': { status: 'ok', title: 'zstd-jni bundles aarch64', detail: 'Linux aarch64 natives included.' },
  'org.xerial:sqlite-jdbc': { status: 'ok', title: 'sqlite-jdbc bundles aarch64', detail: 'Linux aarch64 natives included.' },
  'net.java.dev.jna:jna': { status: 'ok', title: 'JNA 5 bundles aarch64', detail: 'Supported from 5.0.', minVersion: '5.0.0' },
  'org.fusesource.leveldbjni:leveldbjni-all': { status: 'block', title: 'leveldbjni has no aarch64 natives', detail: 'The last release (1.8, 2013) only bundles x86 Linux libraries.', fix: 'Swap for org.iq80.leveldb:leveldb (pure Java) or RocksDB.', effort: 'M' },
  'com.intel.qat:qat-java': { status: 'block', title: 'Intel QAT is x86 hardware', detail: 'QuickAssist offload is not available on Arm instances.', fix: 'Fall back to software compression on arm64.', effort: 'M' },
}

/** Rust crates that link C code. */
export const CARGO: Record<string, Note> = {
  'openssl-sys': { status: 'warn', title: 'Links OpenSSL', detail: 'Cross-compiling needs aarch64 OpenSSL headers; native arm64 builds just need libssl-dev.', fix: 'Build on an arm64 runner, or enable the "vendored" feature, or move to rustls.', effort: 'S' },
  'ring': { status: 'ok', title: 'ring has aarch64 assembly', detail: 'Supported on aarch64-unknown-linux-gnu and -musl.' },
  'rdkafka-sys': { status: 'warn', title: 'Builds librdkafka from C', detail: 'Needs cmake and a C compiler for the target.', fix: 'Build on an arm64 runner or install an aarch64 cross toolchain.', effort: 'S' },
}

/** x86 instance family -> Arm family by Graviton generation. */
export const FAMILY_MAP: Record<string, { g3: string; g4: string }> = {
  m5: { g3: 'm7g', g4: 'm8g' }, m5a: { g3: 'm7g', g4: 'm8g' }, m6i: { g3: 'm7g', g4: 'm8g' }, m6a: { g3: 'm7g', g4: 'm8g' }, m7i: { g3: 'm7g', g4: 'm8g' }, m7a: { g3: 'm7g', g4: 'm8g' },
  c5: { g3: 'c7g', g4: 'c8g' }, c5a: { g3: 'c7g', g4: 'c8g' }, c6i: { g3: 'c7g', g4: 'c8g' }, c6a: { g3: 'c7g', g4: 'c8g' }, c7i: { g3: 'c7g', g4: 'c8g' }, c7a: { g3: 'c7g', g4: 'c8g' },
  r5: { g3: 'r7g', g4: 'r8g' }, r5a: { g3: 'r7g', g4: 'r8g' }, r6i: { g3: 'r7g', g4: 'r8g' }, r6a: { g3: 'r7g', g4: 'r8g' }, r7i: { g3: 'r7g', g4: 'r8g' }, r7a: { g3: 'r7g', g4: 'r8g' },
  t3: { g3: 't4g', g4: 't4g' }, t3a: { g3: 't4g', g4: 't4g' },
}
