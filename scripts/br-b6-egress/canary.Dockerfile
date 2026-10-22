# =============================================================================
# br-b6e canary image — alpine:3.20 + python3 (protocol-aware TCP logger).
# Base pinned to the locally-present alpine:3.20; python3 from the alpine 3.20
# repo (busybox nc lacks the needed socket control — live-found 2026-10-22).
# =============================================================================
FROM alpine:3.20
RUN apk add --no-cache python3
COPY canary.py /canary.py
ENTRYPOINT ["python3", "/canary.py"]
CMD ["16370"]
