// Synthetic sample repo. Service names, registries and code are made up; the third-party
// images and packages are real so the live scanner has something true to resolve.
import type { RepoFile } from './types.ts'

const HEAD = '# SYNTHETIC SAMPLE (Arm Ready demo repo "shopfront"), not a real company'

export const SAMPLE_NAME = 'shopfront (synthetic sample)'

export const SAMPLE_FILES: RepoFile[] = [
  {
    path: 'services/api/Dockerfile',
    text: `${HEAD}
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
      libpq5 curl ca-certificates xz-utils \\
 && rm -rf /var/lib/apt/lists/*
# Static ffmpeg for product-image thumbnails
RUN curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \\
      | tar -xJ --strip-components=1 -C /usr/local/bin
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu
EXPOSE 8000
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:create_app()"]
`,
  },
  {
    path: 'services/api/requirements.txt',
    text: `# SYNTHETIC SAMPLE
flask==3.0.3
gunicorn==22.0.0
numpy==1.26.4
pandas==2.2.2
psycopg2-binary==2.9.9
grpcio==1.62.1
mysqlclient==2.2.4
requests==2.32.3
`,
  },
  {
    path: 'services/web/Dockerfile',
    text: `${HEAD}
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
CMD ["node", "dist/server.js"]
`,
  },
  {
    path: 'services/web/package-lock.json',
    text: JSON.stringify({
      name: 'shopfront-web', version: '2.4.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'shopfront-web', version: '2.4.0', dependencies: { express: '^4.19.2', sharp: '^0.33.4', bcrypt: '^5.1.1', 'node-sass': '^4.14.1', 'better-sqlite3': '^11.1.2' } },
        'node_modules/express': { version: '4.19.2' },
        'node_modules/body-parser': { version: '1.20.2' },
        'node_modules/cookie': { version: '0.6.0' },
        'node_modules/sharp': { version: '0.33.4', hasInstallScript: true },
        'node_modules/@img/sharp-linux-x64': { version: '0.33.4', optional: true, os: ['linux'], cpu: ['x64'] },
        'node_modules/@img/sharp-linux-arm64': { version: '0.33.4', optional: true, os: ['linux'], cpu: ['arm64'] },
        'node_modules/bcrypt': { version: '5.1.1', hasInstallScript: true },
        'node_modules/node-sass': { version: '4.14.1', hasInstallScript: true },
        'node_modules/better-sqlite3': { version: '11.1.2', hasInstallScript: true },
        'node_modules/esbuild': { version: '0.21.5', dev: true, hasInstallScript: true },
        'node_modules/@esbuild/linux-x64': { version: '0.21.5', dev: true, optional: true, os: ['linux'], cpu: ['x64'] },
        'node_modules/@esbuild/linux-arm64': { version: '0.21.5', dev: true, optional: true, os: ['linux'], cpu: ['arm64'] },
        'node_modules/husky': { version: '9.0.11', dev: true },
      },
    }, null, 2),
  },
  {
    path: 'services/worker/Dockerfile',
    text: `${HEAD}
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/worker ./cmd/worker

FROM gcr.io/distroless/base-debian12
COPY --from=build /out/worker /worker
ENTRYPOINT ["/worker"]
`,
  },
  {
    path: 'services/worker/go.mod',
    text: `// SYNTHETIC SAMPLE
module example.com/shopfront/worker

go 1.22

require (
	github.com/aws/aws-sdk-go-v2 v1.30.3
	github.com/mattn/go-sqlite3 v1.14.22
	github.com/prometheus/client_golang v1.19.1
	github.com/redis/go-redis/v9 v9.5.3
	go.uber.org/zap v1.27.0
)
`,
  },
  {
    path: 'services/billing/Dockerfile',
    text: `${HEAD}
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

FROM eclipse-temurin:21-jre
ARG YQ_VERSION=v4.44.3
RUN wget -qO /usr/local/bin/yq https://github.com/mikefarah/yq/releases/download/\${YQ_VERSION}/yq_linux_amd64 \\
 && chmod +x /usr/local/bin/yq
ARG TARGETARCH
RUN curl -fsSLo /bin/grpc_health_probe https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/v0.4.28/grpc_health_probe-linux-\${TARGETARCH} \\
 && chmod +x /bin/grpc_health_probe
COPY --from=build /src/target/billing.jar /app/billing.jar
ENTRYPOINT ["java", "-XX:+UseZGC", "-jar", "/app/billing.jar"]
`,
  },
  {
    path: 'services/billing/pom.xml',
    text: `<?xml version="1.0" encoding="UTF-8"?>
<!-- SYNTHETIC SAMPLE -->
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example.shopfront</groupId>
  <artifactId>billing</artifactId>
  <version>3.2.0</version>
  <properties>
    <netty.version>4.1.111.Final</netty.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>io.netty</groupId>
      <artifactId>netty-transport-native-epoll</artifactId>
      <version>\${netty.version}</version>
      <classifier>linux-x86_64</classifier>
    </dependency>
    <dependency>
      <groupId>org.rocksdb</groupId>
      <artifactId>rocksdbjni</artifactId>
      <version>8.11.4</version>
    </dependency>
    <dependency>
      <groupId>org.lz4</groupId>
      <artifactId>lz4-java</artifactId>
      <version>1.7.1</version>
    </dependency>
    <dependency>
      <groupId>org.postgresql</groupId>
      <artifactId>postgresql</artifactId>
      <version>42.7.3</version>
    </dependency>
  </dependencies>
</project>
`,
  },
  {
    path: 'deploy/k8s/workloads.yaml',
    text: `${HEAD}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 6
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/shopfront/api:1.8.2
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  template:
    spec:
      containers:
        - name: web
          image: registry.example.com/shopfront/web:2.4.0
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: worker
          image: registry.example.com/shopfront/worker:0.9.7
        - name: cache
          image: redis:7.2-alpine
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: billing
spec:
  replicas: 2
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: amd64
      containers:
        - name: billing
          image: registry.example.com/shopfront/billing:3.2.0
---
# Vendor reporting database (third-party image, unchanged)
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: reports-db
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: mssql
          image: mcr.microsoft.com/mssql/server:2022-latest
`,
  },
  {
    path: 'docker-compose.yml',
    text: `${HEAD}
services:
  api:
    build: ./services/api
    image: registry.example.com/shopfront/api:dev
  postgres:
    image: postgres:16.3
  queue:
    image: rabbitmq:3.13-management
  traces:
    image: jaegertracing/all-in-one:1.57
`,
  },
]

export const SAMPLE_INVENTORY = `service,instance_type,count,hours_per_month
api,c5a.2xlarge,6,730
web,m5.xlarge,4,730
worker,c6i.4xlarge,3,730
billing,r5.xlarge,2,730
reports-db,r6i.2xlarge,1,730
`
