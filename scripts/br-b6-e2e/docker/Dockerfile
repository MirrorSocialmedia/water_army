# BR-B6 sandbox E2E — minimal ADB version responder (MD §14.3 test container).
#
# WHY: the batch container adapter's app-layer health IS the ADB wire handshake
# (000chost:version → 4-hex-len + version frame). A real Redroid device is the
# §14.4 real-host scope; for the 200-identity sandbox cycle a few-MB container
# that answers the handshake honestly is the right tool (fast boot, real
# port-lease + volume-mount + stop/adopt code paths, zero GPU).
#
# Behavior:
#   - TCP :5555: every connection gets the ADB version frame
#     '00120.0.1-brb6-sandbox' (len 0x12 = 18 chars of '0.0.1-brb6-sandbox').
#   - /data: appends a heartbeat line every 2s (proves the identity volume is
#     really mounted writable and RETAINED after stop — MD §14.3 item 3).
#
# Base pinned BY DIGEST (no tag drift, no `latest` — B6 image rule).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN mkdir -p /data
COPY entrypoint.sh /entrypoint.sh
COPY resp.sh /resp.sh
RUN chmod +x /entrypoint.sh /resp.sh

EXPOSE 5555
ENTRYPOINT ["/entrypoint.sh"]
