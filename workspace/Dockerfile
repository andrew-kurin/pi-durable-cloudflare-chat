FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates coreutils util-linux && rm -rf /var/lib/apt/lists/*
# No model client, application source, credentials, repository or tokens are baked in.
ENTRYPOINT ["sleep", "infinity"]
