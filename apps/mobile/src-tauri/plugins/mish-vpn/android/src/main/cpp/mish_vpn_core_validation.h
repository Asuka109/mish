#ifndef MISH_VPN_CORE_VALIDATION_H
#define MISH_VPN_CORE_VALIDATION_H

#include <stdint.h>

#include "mish_mobile_core.h"

typedef uint32_t (*MishVpnCoreAbiVersionFn)(void);
typedef int32_t (*MishVpnCoreInitializeFn)(MishCorePlatformV1 *platform,
                                          uint8_t *request,
                                          uint64_t request_length,
                                          MishCoreBufferV1 *response);
typedef int32_t (*MishVpnCoreValidateConfigFn)(uint8_t *config,
                                               uint64_t config_length,
                                               MishCoreBufferV1 *response);
typedef int32_t (*MishVpnCoreLoadConfigFn)(uint8_t *config,
                                           uint64_t config_length,
                                           MishCoreBufferV1 *response);
typedef int32_t (*MishVpnCoreSnapshotFn)(uint8_t *request,
                                         uint64_t request_length,
                                         MishCoreBufferV1 *response);
typedef void (*MishVpnCoreFreeBufferFn)(MishCoreBufferV1 *buffer);

typedef struct MishVpnCoreValidationApi {
  MishVpnCoreAbiVersionFn abi_version;
  MishVpnCoreInitializeFn initialize;
  MishVpnCoreValidateConfigFn validate_config;
  MishVpnCoreLoadConfigFn load_config;
  MishVpnCoreSnapshotFn snapshot;
  MishVpnCoreFreeBufferFn free_buffer;
} MishVpnCoreValidationApi;

typedef enum MishVpnCoreValidationCode {
  MISH_VPN_VALIDATION_VALID = 0,
  MISH_VPN_VALIDATION_CONFIG_REJECTED = 1,
  MISH_VPN_VALIDATION_CONFIG_TOO_LARGE = 2,
  MISH_VPN_VALIDATION_CORE_UNAVAILABLE = 3,
  MISH_VPN_VALIDATION_INITIALIZATION_FAILED = 4,
  MISH_VPN_VALIDATION_MALFORMED_RESPONSE = 5,
  MISH_VPN_VALIDATION_RESPONSE_TOO_LARGE = 6,
  MISH_VPN_VALIDATION_NATIVE_FAILED = 7
} MishVpnCoreValidationCode;

typedef struct MishVpnCoreValidationResult {
  int32_t code;
  int32_t abi_status;
} MishVpnCoreValidationResult;

MishVpnCoreValidationResult mish_vpn_validate_config(
    const MishVpnCoreValidationApi *api, int *initialized, uint8_t *config,
    uint64_t config_length, const char *expected_digest);

typedef enum MishVpnCoreLoadCode {
  MISH_VPN_LOAD_LOADED = 0,
  MISH_VPN_LOAD_CONFIG_REJECTED = 1,
  MISH_VPN_LOAD_CONFLICT = 2,
  MISH_VPN_LOAD_CORE_UNAVAILABLE = 3,
  MISH_VPN_LOAD_NOT_INITIALIZED = 4,
  MISH_VPN_LOAD_MALFORMED_RESPONSE = 5,
  MISH_VPN_LOAD_RESPONSE_TOO_LARGE = 6,
  MISH_VPN_LOAD_NATIVE_FAILED = 7
} MishVpnCoreLoadCode;

typedef struct MishVpnCoreLoadResult {
  int32_t code;
  int32_t abi_status;
  int32_t rollback_guaranteed;
} MishVpnCoreLoadResult;

MishVpnCoreLoadResult mish_vpn_load_config(
    const MishVpnCoreValidationApi *api, int initialized, uint8_t *config,
    uint64_t config_length, const char *expected_digest);

typedef enum MishVpnCoreInspectionCode {
  MISH_VPN_INSPECTION_UNLOADED = 0,
  MISH_VPN_INSPECTION_LOADED_EXPECTED = 1,
  MISH_VPN_INSPECTION_LOADED_OTHER = 2,
  MISH_VPN_INSPECTION_MALFORMED_RESPONSE = 3,
  MISH_VPN_INSPECTION_RESPONSE_TOO_LARGE = 4,
  MISH_VPN_INSPECTION_NATIVE_FAILED = 5
} MishVpnCoreInspectionCode;

typedef struct MishVpnCoreInspectionResult {
  int32_t code;
  int32_t abi_status;
} MishVpnCoreInspectionResult;

MishVpnCoreInspectionResult mish_vpn_inspect_loaded_config(
    const MishVpnCoreValidationApi *api, int initialized,
    const char *expected_digest);

#endif
