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

if [ "$validate" != true ]; then
  trap 'exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

echo "$$" > "${config_file}.validation-pid"

mode=""
while IFS= read -r line; do
  case "$line" in
    *"geodata-test-unknown: true"*) mode="unknown" ;;
    *"geodata-test-slow-success: true"*) mode="slow-success" ;;
    *"geodata-test-success: true"*) mode="success" ;;
    *"geodata-test-failure: true"*) mode="failure" ;;
    *"geodata-test-timeout: true"*) mode="timeout" ;;
  esac
done < "$config_file"

if [ "$mode" = "unknown" ]; then
  index=0
  while [ "$index" -lt 4096 ]; do
    echo "unknown validation output https://user:secret@example.invalid/private/$index" >&2
    index=$((index + 1))
  done
  exit 0
fi

if [ "$mode" = "success" ]; then
  printf "[info] Can't find Geo"
  sleep 0.05
  printf "Site.dat, start download\n"
  sleep 0.05
  echo "[info] Download GeoSite.dat finish"
  exit 0
fi

if [ "$mode" = "slow-success" ]; then
  echo "[info] Can't find GeoSite.dat, start download"
  sleep 2
  echo "[info] Download GeoSite.dat finish"
  exit 0
fi

if [ "$mode" = "failure" ]; then
  echo "[info] Can't find GeoIP.dat, start download" >&2
  echo "[error] can't download GeoIP.dat: https://token@example.invalid/private" >&2
  exit 17
fi

if [ "$mode" = "timeout" ]; then
  echo "[info] Can't find MMDB, start download"
  sleep 5
  exit 0
fi

exit 0
