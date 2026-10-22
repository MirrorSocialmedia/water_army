# =============================================================================
# br-b6e sidecar — root-free "nsenter" stand-in for the device netns/pidns.
#
# Usage (one-shot, joined to the device container's namespaces by the docker
# daemon — no host root needed):
#   docker run --rm --net container:<dev> --pid container:<dev> \
#     --entrypoint busybox br-b6e-sidecar:egress <cmd...>
#
# iproute2 is added for the platform netcheck (table-100 / rule-5000 views —
# busybox `ip` cannot show custom tables). Base pinned to the locally-present
# alpine:3.20 (no floating tags anywhere).
# =============================================================================
FROM alpine:3.20
RUN apk add --no-cache iproute2
