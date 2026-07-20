# Mobile Core Build Disk Evidence

Measurement date: 2026-07-20

The dual-ABI, dual-output reproducibility build used 3,297,548 KiB of task-owned
scratch space at the measured peak:

| Scratch area                            |  Peak KiB |
| --------------------------------------- | --------: |
| Source build, module cache, and outputs | 2,969,848 |
| Verified Go toolchain and archive       |   327,548 |
| Generated evidence                     |       152 |
| Total                                   | 3,297,548 |

The measurement excludes the pre-existing Android NDK installation. A second
build under a different absolute scratch root produced the same hashes for both
ABIs, confirming that local source paths are not embedded in the artifacts. No
emulator or system image was installed.

After verification, all reproducible libraries, generated headers, build caches,
and temporary Go toolchain files were moved to the system Trash. Retained native
artifact occupancy is therefore 0 KiB. The committed text-only evidence occupied
156 KiB including this notice.
