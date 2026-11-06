# Build on Debian bookworm (glibc 2.36); run on Ubuntu 24.04 because the pinned RaxoSentinel
# release binary requires glibc >= 2.39 and shares this image's runtime for the staging socket.
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN cargo build --release --locked

FROM ubuntu:24.04 AS runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && userdel -r ubuntu \
 && useradd -u 1000 -m -s /usr/sbin/nologin raxo \
 && mkdir -p /app/storage /app/config /run/raxosentinel \
 && chown -R raxo:raxo /app /run/raxosentinel
COPY --from=builder /build/target/release/raxo-api /build/target/release/raxo-worker \
     /build/target/release/raxo-migrate /build/target/release/raxo-cli /usr/local/bin/
WORKDIR /app
USER raxo
EXPOSE 3000
CMD ["raxo-api"]
