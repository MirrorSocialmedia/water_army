#!/bin/sh
# ADB version responder — invoked by busybox nc -lk per connection.
# stdout goes to the socket; the probe (defaultAdbProbe) only needs to READ
# the frame — it never waits for us to read its command. printf exits as
# soon as the frame is written, so a wedged client can never wedge the
# persistent listener.
printf '00120.0.1-brb6-sandbox'
