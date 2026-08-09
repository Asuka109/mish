#include "mish_vpn_core_validation.h"

#include <stddef.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

typedef enum EnvelopeCheck {
  ENVELOPE_VALID = 0,
  ENVELOPE_MALFORMED = 1,
  ENVELOPE_TOO_LARGE = 2
} EnvelopeCheck;

static MishVpnCoreValidationResult result(int32_t code, int32_t abi_status) {
  MishVpnCoreValidationResult value = {
      .code = code,
      .abi_status = abi_status,
  };
  return value;
}

static MishVpnCoreLoadResult load_result(int32_t code, int32_t abi_status,
                                         int32_t rollback_guaranteed) {
  MishVpnCoreLoadResult value = {
      .code = code,
      .abi_status = abi_status,
      .rollback_guaranteed = rollback_guaranteed,
  };
  return value;
}

static MishVpnCoreInspectionResult inspection_result(int32_t code,
                                                     int32_t abi_status) {
  MishVpnCoreInspectionResult value = {
      .code = code,
      .abi_status = abi_status,
  };
  return value;
}

static MishVpnCoreRuntimeResult runtime_result(int32_t code,
                                               int32_t abi_status) {
  MishVpnCoreRuntimeResult value = {
      .code = code,
      .abi_status = abi_status,
  };
  return value;
}

static int32_t reject_validation_socket(int32_t socket_fd, void *user_data) {
  (void)socket_fd;
  (void)user_data;
  return -1;
}

static int contains(const MishCoreBufferV1 *buffer, const char *needle) {
  size_t index;
  size_t needle_length = strlen(needle);
  if (needle_length > buffer->length) {
    return 0;
  }
  for (index = 0; index + needle_length <= buffer->length; index++) {
    if (memcmp(buffer->data + index, needle, needle_length) == 0) {
      return 1;
    }
  }
  return 0;
}

static int valid_digest(const char *digest) {
  size_t index;
  if (digest == NULL || strlen(digest) != 64) {
    return 0;
  }
  for (index = 0; index < 64; index++) {
    char byte = digest[index];
    if (!((byte >= '0' && byte <= '9') || (byte >= 'a' && byte <= 'f'))) {
      return 0;
    }
  }
  return 1;
}

static int valid_identifier(const char *value) {
  size_t index;
  size_t length;
  if (value == NULL) {
    return 0;
  }
  length = strlen(value);
  if (length == 0 || length > 128) {
    return 0;
  }
  for (index = 0; index < length; index++) {
    char byte = value[index];
    if (!((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
          (byte >= '0' && byte <= '9') || byte == '-' || byte == '_' ||
          byte == '.')) {
      return 0;
    }
  }
  return 1;
}

static int valid_lifecycle_authority(
    const MishVpnCoreLifecycleAuthority *authority) {
  return authority != NULL &&
         valid_identifier(authority->machine_authority) &&
         authority->scope_epoch > 0 &&
         valid_identifier(authority->operation_id) &&
         authority->admitted_revision > 0 &&
         valid_identifier(authority->effect_identity);
}

static int contains_digest(const MishCoreBufferV1 *buffer,
                           const char *expected_digest) {
  char needle[96];
  if (!valid_digest(expected_digest)) {
    return 0;
  }
  snprintf(needle, sizeof(needle), "\"configSha256\":\"%s\"",
           expected_digest);
  return contains(buffer, needle);
}

static int valid_utf8(const uint8_t *bytes, uint64_t length) {
  uint64_t index = 0;
  while (index < length) {
    uint8_t byte = bytes[index];
    uint32_t code_point;
    uint64_t remaining;
    if (byte <= 0x7f) {
      if (byte < 0x20) {
        return 0;
      }
      index++;
      continue;
    }
    if ((byte & 0xe0) == 0xc0) {
      code_point = byte & 0x1f;
      remaining = 1;
    } else if ((byte & 0xf0) == 0xe0) {
      code_point = byte & 0x0f;
      remaining = 2;
    } else if ((byte & 0xf8) == 0xf0) {
      code_point = byte & 0x07;
      remaining = 3;
    } else {
      return 0;
    }
    if (index + remaining >= length) {
      return 0;
    }
    while (remaining > 0) {
      uint8_t continuation = bytes[++index];
      if ((continuation & 0xc0) != 0x80) {
        return 0;
      }
      code_point = (code_point << 6) | (continuation & 0x3f);
      remaining--;
    }
    if ((code_point <= 0x7f) ||
        (code_point <= 0x7ff && (byte & 0xf0) == 0xe0) ||
        (code_point <= 0xffff && (byte & 0xf8) == 0xf0) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return 0;
    }
    index++;
  }
  return 1;
}

static EnvelopeCheck basic_envelope(const MishCoreBufferV1 *buffer) {
  if (buffer->length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    return ENVELOPE_TOO_LARGE;
  }
  if (buffer->data == NULL || buffer->length < 2 ||
      !valid_utf8(buffer->data, buffer->length) || buffer->data[0] != '{' ||
      buffer->data[buffer->length - 1] != '}' ||
      !contains(buffer, "\"abiVersion\":1")) {
    return ENVELOPE_MALFORMED;
  }
  return ENVELOPE_VALID;
}

static const char *status_error_code(int32_t status) {
  switch (status) {
  case MISH_CORE_INVALID_ARGUMENT_V1:
    return "\"code\":\"invalid-argument\"";
  case MISH_CORE_NOT_INITIALIZED_V1:
    return "\"code\":\"not-initialized\"";
  case MISH_CORE_NOT_LOADED_V1:
    return "\"code\":\"not-loaded\"";
  case MISH_CORE_CONFIG_REJECTED_V1:
    return "\"code\":\"config-rejected\"";
  case MISH_CORE_CONFLICT_V1:
    return "\"code\":\"conflict\"";
  case MISH_CORE_LIMIT_EXCEEDED_V1:
    return "\"code\":\"limit-exceeded\"";
  case MISH_CORE_UNSUPPORTED_V1:
    return "\"code\":\"unsupported\"";
  case MISH_CORE_FAILURE_V1:
    return "\"code\":\"core-failure\"";
  default:
    return NULL;
  }
}

static EnvelopeCheck initialization_envelope(const MishCoreBufferV1 *buffer,
                                             int32_t status) {
  EnvelopeCheck check = basic_envelope(buffer);
  const char *error_code;
  if (check != ENVELOPE_VALID) {
    return check;
  }
  if (status == MISH_CORE_OK_V1) {
    if (!contains(buffer, "\"data\":{") || contains(buffer, "\"error\":") ||
        !contains(buffer, "\"loaded\":false") ||
        !contains(buffer, "\"phase\":\"inactive\"")) {
      return ENVELOPE_MALFORMED;
    }
    return ENVELOPE_VALID;
  }
  error_code = status_error_code(status);
  if (error_code == NULL || !contains(buffer, "\"error\":{") ||
      !contains(buffer, error_code) || contains(buffer, "\"data\":")) {
    return ENVELOPE_MALFORMED;
  }
  return ENVELOPE_VALID;
}

static EnvelopeCheck runtime_initialization_envelope(
    const MishCoreBufferV1 *buffer, int32_t status) {
  EnvelopeCheck check = basic_envelope(buffer);
  if (check != ENVELOPE_VALID) {
    return check;
  }
  if (status != MISH_CORE_OK_V1 || !contains(buffer, "\"data\":{") ||
      contains(buffer, "\"error\":") ||
      !contains(buffer, "\"loaded\":true") ||
      !contains(buffer, "\"phase\":\"inactive\"")) {
    return ENVELOPE_MALFORMED;
  }
  return ENVELOPE_VALID;
}

static EnvelopeCheck validation_envelope(const MishCoreBufferV1 *buffer,
                                         int32_t status,
                                         const char *expected_digest) {
  EnvelopeCheck check = basic_envelope(buffer);
  const char *error_code;
  if (check != ENVELOPE_VALID) {
    return check;
  }
  if (status == MISH_CORE_OK_V1) {
    if (!contains(buffer, "\"data\":{") || contains(buffer, "\"error\":") ||
        !contains_digest(buffer, expected_digest) ||
        !contains(buffer, "\"valid\":true")) {
      return ENVELOPE_MALFORMED;
    }
    return ENVELOPE_VALID;
  }
  error_code = status_error_code(status);
  if (error_code == NULL || !contains(buffer, "\"error\":{") ||
      !contains(buffer, error_code) || contains(buffer, "\"data\":")) {
    return ENVELOPE_MALFORMED;
  }
  return ENVELOPE_VALID;
}

static EnvelopeCheck load_envelope(const MishCoreBufferV1 *buffer,
                                   int32_t status,
                                   const char *expected_digest) {
  EnvelopeCheck check = basic_envelope(buffer);
  const char *error_code;
  if (check != ENVELOPE_VALID) {
    return check;
  }
  if (status == MISH_CORE_OK_V1) {
    if (!contains(buffer, "\"data\":{") || contains(buffer, "\"error\":") ||
        !contains_digest(buffer, expected_digest) ||
        !contains(buffer, "\"loaded\":true") ||
        !contains(buffer, "\"phase\":\"inactive\"")) {
      return ENVELOPE_MALFORMED;
    }
    return ENVELOPE_VALID;
  }
  error_code = status_error_code(status);
  if (error_code == NULL || !contains(buffer, "\"error\":{") ||
      !contains(buffer, error_code) || contains(buffer, "\"data\":")) {
    return ENVELOPE_MALFORMED;
  }
  return ENVELOPE_VALID;
}

static MishVpnCoreValidationResult checked_result(EnvelopeCheck check,
                                                  int32_t status) {
  if (check == ENVELOPE_TOO_LARGE) {
    return result(MISH_VPN_VALIDATION_RESPONSE_TOO_LARGE, status);
  }
  if (check == ENVELOPE_MALFORMED) {
    return result(MISH_VPN_VALIDATION_MALFORMED_RESPONSE, status);
  }
  return result(MISH_VPN_VALIDATION_NATIVE_FAILED, status);
}

MishVpnCoreValidationResult mish_vpn_validate_config(
    const MishVpnCoreValidationApi *api, int *initialized, uint8_t *config,
    uint64_t config_length, const char *expected_digest) {
  static uint8_t initialize_request[] = "{\"abiVersion\":1}";
  MishCoreBufferV1 response = {0};
  MishCorePlatformV1 platform = {
      .struct_size = sizeof(MishCorePlatformV1),
      .protect_socket = reject_validation_socket,
      .user_data = NULL,
  };
  EnvelopeCheck check;
  int32_t status;

  if (config_length > MISH_CORE_MAX_CONFIG_BYTES_V1) {
    return result(MISH_VPN_VALIDATION_CONFIG_TOO_LARGE,
                  MISH_CORE_LIMIT_EXCEEDED_V1);
  }
  if (initialized == NULL || (config == NULL && config_length != 0) ||
      !valid_digest(expected_digest) ||
      api == NULL || api->abi_version == NULL || api->initialize == NULL ||
      api->validate_config == NULL || api->free_buffer == NULL ||
      api->abi_version() != MISH_CORE_ABI_VERSION_V1) {
    return result(MISH_VPN_VALIDATION_CORE_UNAVAILABLE, -1);
  }

  if (!*initialized) {
    status = api->initialize(&platform, initialize_request,
                             sizeof(initialize_request) - 1, &response);
    check = initialization_envelope(&response, status);
    api->free_buffer(&response);
    if (check != ENVELOPE_VALID) {
      return checked_result(check, status);
    }
    if (status != MISH_CORE_OK_V1) {
      return result(MISH_VPN_VALIDATION_INITIALIZATION_FAILED, status);
    }
    *initialized = 1;
  }

  status = api->validate_config(config, config_length, &response);
  check = validation_envelope(&response, status, expected_digest);
  api->free_buffer(&response);
  if (check != ENVELOPE_VALID) {
    return checked_result(check, status);
  }

  switch (status) {
  case MISH_CORE_OK_V1:
    return result(MISH_VPN_VALIDATION_VALID, status);
  case MISH_CORE_INVALID_ARGUMENT_V1:
  case MISH_CORE_CONFIG_REJECTED_V1:
    return result(MISH_VPN_VALIDATION_CONFIG_REJECTED, status);
  case MISH_CORE_LIMIT_EXCEEDED_V1:
    return result(MISH_VPN_VALIDATION_CONFIG_TOO_LARGE, status);
  case MISH_CORE_NOT_INITIALIZED_V1:
    *initialized = 0;
    return result(MISH_VPN_VALIDATION_INITIALIZATION_FAILED, status);
  case MISH_CORE_UNSUPPORTED_V1:
    return result(MISH_VPN_VALIDATION_CORE_UNAVAILABLE, status);
  case MISH_CORE_NOT_LOADED_V1:
  case MISH_CORE_CONFLICT_V1:
  case MISH_CORE_FAILURE_V1:
  default:
    return result(MISH_VPN_VALIDATION_NATIVE_FAILED, status);
  }
}

MishVpnCoreLoadResult mish_vpn_load_config(
    const MishVpnCoreValidationApi *api, int initialized, uint8_t *config,
    uint64_t config_length, const char *expected_digest) {
  MishCoreBufferV1 response = {0};
  EnvelopeCheck check;
  int32_t status;

  if (!initialized) {
    return load_result(MISH_VPN_LOAD_NOT_INITIALIZED,
                       MISH_CORE_NOT_INITIALIZED_V1, 1);
  }
  if ((config == NULL && config_length != 0) ||
      config_length > MISH_CORE_MAX_CONFIG_BYTES_V1 ||
      !valid_digest(expected_digest) || api == NULL ||
      api->load_config == NULL || api->free_buffer == NULL) {
    return load_result(MISH_VPN_LOAD_CORE_UNAVAILABLE, -1, 1);
  }

  status = api->load_config(config, config_length, &response);
  check = load_envelope(&response, status, expected_digest);
  api->free_buffer(&response);
  if (check == ENVELOPE_TOO_LARGE) {
    return load_result(MISH_VPN_LOAD_RESPONSE_TOO_LARGE, status, 0);
  }
  if (check == ENVELOPE_MALFORMED) {
    return load_result(MISH_VPN_LOAD_MALFORMED_RESPONSE, status, 0);
  }

  switch (status) {
  case MISH_CORE_OK_V1:
    return load_result(MISH_VPN_LOAD_LOADED, status, 0);
  case MISH_CORE_INVALID_ARGUMENT_V1:
  case MISH_CORE_CONFIG_REJECTED_V1:
  case MISH_CORE_LIMIT_EXCEEDED_V1:
    return load_result(MISH_VPN_LOAD_CONFIG_REJECTED, status, 1);
  case MISH_CORE_CONFLICT_V1:
    return load_result(MISH_VPN_LOAD_CONFLICT, status, 1);
  case MISH_CORE_NOT_INITIALIZED_V1:
    return load_result(MISH_VPN_LOAD_NOT_INITIALIZED, status, 1);
  case MISH_CORE_UNSUPPORTED_V1:
    return load_result(MISH_VPN_LOAD_CORE_UNAVAILABLE, status, 1);
  case MISH_CORE_NOT_LOADED_V1:
  case MISH_CORE_FAILURE_V1:
  default:
    return load_result(MISH_VPN_LOAD_NATIVE_FAILED, status, 1);
  }
}

MishVpnCoreInspectionResult mish_vpn_inspect_loaded_config(
    const MishVpnCoreValidationApi *api, int initialized,
    const char *expected_digest) {
  static uint8_t status_request[] = "{\"kind\":\"status\",\"limit\":1}";
  MishCoreBufferV1 response = {0};
  EnvelopeCheck check;
  int32_t status;

  if (!initialized) {
    return inspection_result(MISH_VPN_INSPECTION_UNLOADED,
                             MISH_CORE_NOT_INITIALIZED_V1);
  }
  if (api == NULL || api->snapshot == NULL || api->free_buffer == NULL) {
    return inspection_result(MISH_VPN_INSPECTION_NATIVE_FAILED, -1);
  }

  status = api->snapshot(status_request, sizeof(status_request) - 1, &response);
  check = basic_envelope(&response);
  if (check == ENVELOPE_TOO_LARGE) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_RESPONSE_TOO_LARGE, status);
  }
  if (check == ENVELOPE_MALFORMED) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_MALFORMED_RESPONSE, status);
  }
  if (status == MISH_CORE_NOT_INITIALIZED_V1 &&
      contains(&response, "\"code\":\"not-initialized\"")) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_UNLOADED, status);
  }
  if (status != MISH_CORE_OK_V1 || !contains(&response, "\"data\":{") ||
      contains(&response, "\"error\":") ||
      !contains(&response, "\"phase\":\"inactive\"")) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_NATIVE_FAILED, status);
  }
  if (contains(&response, "\"loaded\":false") &&
      contains(&response, "\"configSha256\":null")) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_UNLOADED, status);
  }
  if (!contains(&response, "\"loaded\":true") ||
      !contains(&response, "\"configSha256\":\"")) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_MALFORMED_RESPONSE, status);
  }
  if (contains_digest(&response, expected_digest)) {
    api->free_buffer(&response);
    return inspection_result(MISH_VPN_INSPECTION_LOADED_EXPECTED, status);
  }
  api->free_buffer(&response);
  return inspection_result(MISH_VPN_INSPECTION_LOADED_OTHER, status);
}

MishVpnCoreRuntimeResult mish_vpn_start_core(
    const MishVpnCoreValidationApi *api, int *initialized,
    MishCorePlatformV1 *platform,
    const MishVpnCoreLifecycleAuthority *authority, const char *session_id,
    int32_t tun_file_descriptor) {
  static uint8_t initialize_request[] = "{\"abiVersion\":1}";
  char request[1024];
  MishCoreBufferV1 response = {0};
  EnvelopeCheck check;
  int32_t status;
  int request_length;
  char session_needle[160];

  if (api == NULL || initialized == NULL || platform == NULL ||
      api->initialize == NULL || api->start == NULL || api->free_buffer == NULL ||
      api->abi_version == NULL ||
      api->abi_version() != MISH_CORE_ABI_VERSION_V1 ||
      platform->protect_socket == NULL || !valid_lifecycle_authority(authority) ||
      !valid_identifier(session_id) ||
      tun_file_descriptor <= 0) {
    return runtime_result(MISH_VPN_RUNTIME_CORE_UNAVAILABLE, -1);
  }

  status = api->initialize(platform, initialize_request,
                           sizeof(initialize_request) - 1, &response);
  check = runtime_initialization_envelope(&response, status);
  api->free_buffer(&response);
  if (check != ENVELOPE_VALID || status != MISH_CORE_OK_V1) {
    *initialized = 0;
    return runtime_result(check == ENVELOPE_VALID
                              ? MISH_VPN_RUNTIME_NATIVE_FAILED
                              : MISH_VPN_RUNTIME_MALFORMED_RESPONSE,
                          status);
  }
  *initialized = 1;

  request_length = snprintf(
      request, sizeof(request),
      "{\"machineAuthority\":\"%s\",\"scopeEpoch\":%" PRIu64
      ",\"operationId\":\"%s\",\"admittedRevision\":%" PRIu64
      ",\"effectIdentity\":\"%s\",\"sessionId\":\"%s\","
      "\"tunFileDescriptor\":%d,\"stack\":\"mixed\","
      "\"addresses\":[\"172.19.0.1/30\",\"fdfe:dcba:9876::1/126\"],"
      "\"dnsHijack\":[\"1.1.1.1:53\"],"
      "\"mtu\":1500}",
      authority->machine_authority, authority->scope_epoch,
      authority->operation_id, authority->admitted_revision,
      authority->effect_identity, session_id, tun_file_descriptor);
  if (request_length <= 0 || (size_t)request_length >= sizeof(request)) {
    return runtime_result(MISH_VPN_RUNTIME_NATIVE_FAILED,
                          MISH_CORE_INVALID_ARGUMENT_V1);
  }
  status = api->start((uint8_t *)request, (uint64_t)request_length, &response);
  check = basic_envelope(&response);
  snprintf(session_needle, sizeof(session_needle), "\"sessionId\":\"%s\"",
           session_id);
  if (check == ENVELOPE_VALID && status == MISH_CORE_OK_V1 &&
      contains(&response, "\"data\":{") &&
      contains(&response, "\"phase\":\"running\"") &&
      contains(&response, session_needle) && !contains(&response, "\"error\":")) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_RUNNING, status);
  }
  if (check != ENVELOPE_VALID) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_MALFORMED_RESPONSE, status);
  }
  if (status == MISH_CORE_NOT_LOADED_V1) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_NOT_LOADED, status);
  }
  if (status == MISH_CORE_CONFLICT_V1) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_CONFLICT, status);
  }
  if (contains(&response, "platform rejected socket protection")) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_PROTECTION_FAILED, status);
  }
  api->free_buffer(&response);
  return runtime_result(MISH_VPN_RUNTIME_NATIVE_FAILED, status);
}

MishVpnCoreRuntimeResult mish_vpn_stop_core(
    const MishVpnCoreValidationApi *api, int initialized,
    const MishVpnCoreLifecycleAuthority *authority, const char *session_id) {
  char request[768];
  MishCoreBufferV1 response = {0};
  EnvelopeCheck check;
  int request_length;
  int32_t status;

  if (api == NULL || api->stop == NULL || api->free_buffer == NULL ||
      !valid_lifecycle_authority(authority) ||
      (session_id != NULL && !valid_identifier(session_id))) {
    return runtime_result(MISH_VPN_RUNTIME_CORE_UNAVAILABLE, -1);
  }
  if (!initialized) {
    return runtime_result(MISH_VPN_RUNTIME_INACTIVE,
                          MISH_CORE_NOT_INITIALIZED_V1);
  }
  request_length = snprintf(
      request, sizeof(request),
      "{\"machineAuthority\":\"%s\",\"scopeEpoch\":%" PRIu64
      ",\"operationId\":\"%s\",\"admittedRevision\":%" PRIu64
      ",\"effectIdentity\":\"%s\"%s%s%s}",
      authority->machine_authority, authority->scope_epoch,
      authority->operation_id, authority->admitted_revision,
      authority->effect_identity, session_id == NULL ? "" : ",\"sessionId\":\"",
      session_id == NULL ? "" : session_id, session_id == NULL ? "" : "\"");
  if (request_length <= 0 || (size_t)request_length >= sizeof(request)) {
    return runtime_result(MISH_VPN_RUNTIME_NATIVE_FAILED,
                          MISH_CORE_INVALID_ARGUMENT_V1);
  }
  status = api->stop((uint8_t *)request, (uint64_t)request_length, &response);
  check = basic_envelope(&response);
  if (check == ENVELOPE_VALID && status == MISH_CORE_OK_V1 &&
      contains(&response, "\"phase\":\"inactive\"") &&
      !contains(&response, "\"error\":")) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_INACTIVE, status);
  }
  api->free_buffer(&response);
  if (check != ENVELOPE_VALID) {
    return runtime_result(MISH_VPN_RUNTIME_MALFORMED_RESPONSE, status);
  }
  if (status == MISH_CORE_CONFLICT_V1) {
    return runtime_result(MISH_VPN_RUNTIME_CONFLICT, status);
  }
  return runtime_result(MISH_VPN_RUNTIME_NATIVE_FAILED, status);
}

MishVpnCoreRuntimeResult mish_vpn_inspect_runtime(
    const MishVpnCoreValidationApi *api, int initialized,
    const char *session_id) {
  static uint8_t status_request[] = "{\"kind\":\"status\",\"limit\":1}";
  MishCoreBufferV1 response = {0};
  EnvelopeCheck check;
  int32_t status;
  char session_needle[160];

  if (!initialized) {
    return runtime_result(MISH_VPN_RUNTIME_INACTIVE,
                          MISH_CORE_NOT_INITIALIZED_V1);
  }
  if (api == NULL || api->snapshot == NULL || api->free_buffer == NULL ||
      (session_id != NULL && !valid_identifier(session_id))) {
    return runtime_result(MISH_VPN_RUNTIME_CORE_UNAVAILABLE, -1);
  }
  status = api->snapshot(status_request, sizeof(status_request) - 1, &response);
  check = basic_envelope(&response);
  if (check != ENVELOPE_VALID || status != MISH_CORE_OK_V1 ||
      contains(&response, "\"error\":")) {
    api->free_buffer(&response);
    return runtime_result(check == ENVELOPE_VALID
                              ? MISH_VPN_RUNTIME_NATIVE_FAILED
                              : MISH_VPN_RUNTIME_MALFORMED_RESPONSE,
                          status);
  }
  if (contains(&response, "\"phase\":\"inactive\"")) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_INACTIVE, status);
  }
  if (session_id != NULL) {
    snprintf(session_needle, sizeof(session_needle), "\"sessionId\":\"%s\"",
             session_id);
  }
  if (contains(&response, "\"phase\":\"running\"") &&
      (session_id == NULL || contains(&response, session_needle))) {
    api->free_buffer(&response);
    return runtime_result(MISH_VPN_RUNTIME_RUNNING, status);
  }
  api->free_buffer(&response);
  return runtime_result(MISH_VPN_RUNTIME_CONFLICT, status);
}
