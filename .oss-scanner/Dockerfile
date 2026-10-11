# Build image for Anthropic OSS Scanner (https://github.com/anthropics/oss-scanner).
# The scanner builds this with the repository as build context, then runs the
# security audit inside the finished image WITHOUT network access. Everything the
# build and the tests need is therefore fetched here.
FROM oven/bun:1.3-debian

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Dependencies incl. peer dependencies and devDependencies (drizzle-kit, PGlite).
RUN bun install --frozen-lockfile

# Compile the framework (tsc -> ./lib), as for a release.
RUN bun run build

# Tests run against an embedded PGlite database with pgvector (no Docker, no
# external Postgres, no .env needed): `bun run test:local [file ...]`.
# Applying the migrations here warms ./dev-db so later offline runs are fast.
# A failing test must not abort the build. Tests that call external AI providers
# need API keys and network and are expected to fail offline.
RUN bun run test:local src/test/check-connection.test.ts \
    || echo "WARNING: test:local reported failures"
