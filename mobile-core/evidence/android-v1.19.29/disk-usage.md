# Mobile Core Build Disk Evidence

Measurement date: 2026-07-20

The dual-ABI, dual-output reproducibility build used 4,298,856 KiB of task-owned
scratch space at the measured peak:

| Scratch area                            |  Peak KiB |
| --------------------------------------- | --------: |
| Source build, module cache, and outputs | 3,971,204 |
| Verified Go toolchain and archive       |   327,548 |
| C ABI fixture output                    |       104 |
| Total                                   | 4,298,856 |

The measurement excludes the pre-existing Android NDK installation and the
separate research checkout supplied with `--source-dir`. No emulator or system
image was installed.

After verification, all reproducible libraries, generated headers, build caches,
and temporary Go toolchain files were moved to the system Trash. Retained native
artifact occupancy is therefore 0 KiB. The committed text-only evidence occupied
156 KiB including this notice.
