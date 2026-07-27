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
typedef void (*MishVpnCoreFreeBufferFn)(MishCoreBufferV1 *buffer);

typedef struct MishVpnCoreValidationApi {
  MishVpnCoreAbiVersionFn abi_version;
  MishVpnCoreInitializeFn initialize;
  MishVpnCoreValidateConfigFn validate_config;
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
    uint64_t config_length);

#endif
