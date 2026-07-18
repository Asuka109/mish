#!/bin/sh

if [ "$1" = "-v" ]; then
  echo "Mihomo Meta v9.99.0 private-build-detail"
  exit 0
fi

echo "wrong-version core must not validate or start" >&2
exit 91
