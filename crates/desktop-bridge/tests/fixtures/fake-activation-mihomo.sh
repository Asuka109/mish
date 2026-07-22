#!/bin/sh

if [ "$1" = "-v" ]; then
  echo "Mihomo Meta v1.19.29"
  exit 0
fi

config_file=""
validate=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    -f)
      config_file="$2"
      shift 2
      ;;
    -d)
      shift 2
      ;;
    -t)
      validate=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$validate" = true ]; then
  if grep -q "activation-test-invalid: true" "$config_file"; then
    echo "private validation detail from $config_file" >&2
    exit 17
  fi
  exit 0
fi

if grep -q "activation-test-early-exit: true" "$config_file"; then
  sleep 1
  exit 23
fi

if grep -q "activation-test-immediate-exit: true" "$config_file"; then
  exit 23
fi

trap 'exit 0' TERM INT
while true; do
  sleep 1
done
