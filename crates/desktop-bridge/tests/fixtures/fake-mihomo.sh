#!/bin/sh

if [ "$1" = "-v" ]; then
  echo "Mihomo Meta v-test"
  exit 0
fi

trap 'exit 0' TERM INT
while true; do
  sleep 1
done
