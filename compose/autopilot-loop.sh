#!/bin/sh
# Spec §8.5. Probe P6: `gbrain autopilot` exits "No repo path" and does not tick.
# Direct commands only. Do not wrap this in sh -c / bash -c. Never --install.
while true; do
  gbrain sweep --once
  gbrain embed --stale
  sleep "${AUTOPILOT_INTERVAL:-300}"
done
