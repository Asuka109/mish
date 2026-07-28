#!/bin/bash

set -euo pipefail
exec "${MISH_RUNNER_HOOK_ROOT:?}/self-hosted-runner-hygiene.sh" completed
