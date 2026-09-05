#!/bin/sh
# V8 sizes its heap from host RAM, not a cgroup limit — cap it at 75% of the
# container's memory.max so GC kicks in before the kernel OOM-kills us.
set -eu

if [ -n "${NODE_OPTIONS:-}" ]; then
  echo "entrypoint: NODE_OPTIONS already set by the operator, leaving it as-is"
  exec node dist/main
fi

if [ -e /sys/fs/cgroup/memory.max ]; then
  raw=$(cat /sys/fs/cgroup/memory.max 2>/dev/null) || raw=""
elif [ -e /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  raw=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null) || raw=""
else
  raw=""
fi

case "$raw" in
  '' | max | *[!0-9]*) raw="" ;;
esac

# cgroup v1's "unlimited" is reported as this near-LLONG_MAX sentinel, not "max".
if [ -n "$raw" ] && [ "$raw" -ge 9223372036854771712 ]; then
  raw=""
fi

if [ -z "$raw" ]; then
  echo "entrypoint: no cgroup memory limit found, leaving V8's default heap sizing"
  exec node dist/main
fi

mib=$(( raw * 75 / 100 / 1024 / 1024 ))

if [ "$mib" -lt 256 ]; then
  echo "entrypoint: cgroup limit ${raw} bytes -> ${mib} MiB is below the 256 MiB floor, leaving V8's default heap sizing"
  exec node dist/main
fi

export NODE_OPTIONS="--max-old-space-size=${mib}"
echo "entrypoint: cgroup limit ${raw} bytes -> ${NODE_OPTIONS}"
exec node dist/main
