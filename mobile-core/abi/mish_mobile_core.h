#ifndef MISH_MOBILE_CORE_H
#define MISH_MOBILE_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MISH_CORE_ABI_VERSION_V1 1u
#define MISH_CORE_MAX_CONFIG_BYTES_V1 1048576u
#define MISH_CORE_MAX_REQUEST_BYTES_V1 65536u
#define MISH_CORE_MAX_RESPONSE_BYTES_V1 262144u

typedef enum MishCoreStatusV1 {
  MISH_CORE_OK_V1 = 0,
  MISH_CORE_INVALID_ARGUMENT_V1 = 1,
  MISH_CORE_NOT_INITIALIZED_V1 = 2,
  MISH_CORE_NOT_LOADED_V1 = 3,
  MISH_CORE_CONFIG_REJECTED_V1 = 4,
  MISH_CORE_CONFLICT_V1 = 5,
  MISH_CORE_LIMIT_EXCEEDED_V1 = 6,
  MISH_CORE_UNSUPPORTED_V1 = 7,
  MISH_CORE_FAILURE_V1 = 8
} MishCoreStatusV1;

typedef struct MishCoreBufferV1 {
  uint8_t *data;
  uint64_t length;
} MishCoreBufferV1;

/* Return zero when the platform accepted protection for this socket. */
typedef int32_t (*MishCoreProtectSocketFnV1)(int32_t socket_fd, void *user_data);

typedef struct MishCorePlatformV1 {
  uint32_t struct_size;
  MishCoreProtectSocketFnV1 protect_socket;
  void *user_data;
} MishCorePlatformV1;

uint32_t mish_core_abi_version_v1(void);

int32_t mish_core_initialize_v1(MishCorePlatformV1 *platform,
                                uint8_t *request,
                                uint64_t request_length,
                                MishCoreBufferV1 *response);

int32_t mish_core_version_v1(MishCoreBufferV1 *response);

int32_t mish_core_validate_config_v1(uint8_t *config,
                                     uint64_t config_length,
                                     MishCoreBufferV1 *response);

int32_t mish_core_load_config_v1(uint8_t *config,
                                 uint64_t config_length,
                                 MishCoreBufferV1 *response);

int32_t mish_core_start_v1(uint8_t *request,
                           uint64_t request_length,
                           MishCoreBufferV1 *response);

int32_t mish_core_stop_v1(uint8_t *request,
                          uint64_t request_length,
                          MishCoreBufferV1 *response);

int32_t mish_core_snapshot_v1(uint8_t *request,
                              uint64_t request_length,
                              MishCoreBufferV1 *response);

int32_t mish_core_command_v1(uint8_t *request,
                             uint64_t request_length,
                             MishCoreBufferV1 *response);

/* Android binds this closed operation rather than the generic command entry. */
int32_t mish_core_close_connection_v1(uint8_t *request,
                                      uint64_t request_length,
                                      MishCoreBufferV1 *response);

int32_t mish_core_poll_events_v1(uint8_t *request,
                                 uint64_t request_length,
                                 MishCoreBufferV1 *response);

void mish_core_free_buffer_v1(MishCoreBufferV1 *buffer);

#ifdef __cplusplus
}
#endif

#endif
