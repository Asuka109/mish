#include "../../apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/cpp/mish_vpn_core_validation.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum FakeEnvelope {
  FAKE_VALID_INITIALIZATION,
  FAKE_VALID_CONFIG,
  FAKE_VALID_LOAD,
  FAKE_STATUS_UNLOADED,
  FAKE_STATUS_LOADED,
  FAKE_STATUS_RUNNING,
  FAKE_ERROR,
  FAKE_MALFORMED,
  FAKE_OVERSIZED
} FakeEnvelope;

static int abi_version = MISH_CORE_ABI_VERSION_V1;
static int initialize_calls = 0;
static int validate_calls = 0;
static int load_calls = 0;
static int start_calls = 0;
static int stop_calls = 0;
static int snapshot_calls = 0;
static int free_calls = 0;
static int32_t initialize_status = MISH_CORE_OK_V1;
static int32_t validate_status = MISH_CORE_OK_V1;
static int32_t load_status = MISH_CORE_OK_V1;
static int32_t start_status = MISH_CORE_OK_V1;
static int32_t stop_status = MISH_CORE_OK_V1;
static int32_t snapshot_status = MISH_CORE_OK_V1;
static FakeEnvelope initialize_envelope = FAKE_VALID_INITIALIZATION;
static FakeEnvelope validate_envelope = FAKE_VALID_CONFIG;
static FakeEnvelope load_envelope = FAKE_VALID_LOAD;
static FakeEnvelope snapshot_envelope = FAKE_STATUS_UNLOADED;
static const char *expected_digest =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

static int32_t fake_protect_socket(int32_t socket_fd, void *user_data) {
  assert(socket_fd > 0);
  assert(user_data == NULL);
  return 0;
}

static const char *status_code(int32_t status) {
  switch (status) {
  case MISH_CORE_INVALID_ARGUMENT_V1:
    return "invalid-argument";
  case MISH_CORE_NOT_INITIALIZED_V1:
    return "not-initialized";
  case MISH_CORE_NOT_LOADED_V1:
    return "not-loaded";
  case MISH_CORE_CONFIG_REJECTED_V1:
    return "config-rejected";
  case MISH_CORE_CONFLICT_V1:
    return "conflict";
  case MISH_CORE_LIMIT_EXCEEDED_V1:
    return "limit-exceeded";
  case MISH_CORE_UNSUPPORTED_V1:
    return "unsupported";
  default:
    return "core-failure";
  }
}

static void allocate_response(MishCoreBufferV1 *response, FakeEnvelope envelope,
                              int32_t status) {
  char error[256];
  const char *payload;
  size_t length;
  if (envelope == FAKE_VALID_INITIALIZATION) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":null,\"eventSequence\":\"0\",\"loaded\":false,\"mode\":\"rule\",\"phase\":\"inactive\",\"sessionId\":null}}";
  } else if (envelope == FAKE_VALID_CONFIG) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"valid\":true}}";
  } else if (envelope == FAKE_VALID_LOAD) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"eventSequence\":\"1\",\"loaded\":true,\"mode\":\"rule\",\"phase\":\"inactive\",\"sessionId\":null}}";
  } else if (envelope == FAKE_STATUS_UNLOADED) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":null,\"eventSequence\":\"0\",\"loaded\":false,\"mode\":\"rule\",\"phase\":\"inactive\",\"sessionId\":null}}";
  } else if (envelope == FAKE_STATUS_LOADED) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"eventSequence\":\"1\",\"loaded\":true,\"mode\":\"rule\",\"phase\":\"inactive\",\"sessionId\":null}}";
  } else if (envelope == FAKE_STATUS_RUNNING) {
    payload =
        "{\"abiVersion\":1,\"data\":{\"configSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"eventSequence\":\"2\",\"loaded\":true,\"mode\":\"rule\",\"phase\":\"running\",\"sessionId\":\"session-1\"}}";
  } else if (envelope == FAKE_ERROR) {
    snprintf(error, sizeof(error),
             "{\"abiVersion\":1,\"error\":{\"code\":\"%s\",\"message\":\"safe\"}}",
             status_code(status));
    payload = error;
  } else {
    payload = "{\"private\":\"password: fictional-secret\"}";
  }
  length = strlen(payload);
  response->data = malloc(length);
  assert(response->data != NULL);
  memcpy(response->data, payload, length);
  response->length =
      envelope == FAKE_OVERSIZED ? MISH_CORE_MAX_RESPONSE_BYTES_V1 + 1 : length;
}

static uint32_t fake_abi_version(void) { return (uint32_t)abi_version; }

static int32_t fake_initialize(MishCorePlatformV1 *platform, uint8_t *request,
                               uint64_t request_length,
                               MishCoreBufferV1 *response) {
  initialize_calls++;
  assert(platform != NULL);
  assert(platform->protect_socket != NULL);
  assert(request_length == strlen("{\"abiVersion\":1}"));
  assert(memcmp(request, "{\"abiVersion\":1}", request_length) == 0);
  allocate_response(response, initialize_envelope, initialize_status);
  return initialize_status;
}

static int32_t fake_validate(uint8_t *config, uint64_t config_length,
                             MishCoreBufferV1 *response) {
  validate_calls++;
  assert(config != NULL);
  assert(config_length > 0);
  allocate_response(response, validate_envelope, validate_status);
  return validate_status;
}

static int32_t fake_load(uint8_t *config, uint64_t config_length,
                         MishCoreBufferV1 *response) {
  load_calls++;
  assert(config != NULL);
  assert(config_length > 0);
  allocate_response(response, load_envelope, load_status);
  return load_status;
}

static void assert_request_contains(uint8_t *request, uint64_t request_length,
                                    const char *needle) {
  char encoded[768];
  assert(request != NULL);
  assert(request_length < sizeof(encoded));
  memcpy(encoded, request, (size_t)request_length);
  encoded[request_length] = '\0';
  assert(strstr(encoded, needle) != NULL);
}

static int32_t fake_start(uint8_t *request, uint64_t request_length,
                          MishCoreBufferV1 *response) {
  start_calls++;
  assert_request_contains(request, request_length, "\"sessionId\":\"session-1\"");
  assert_request_contains(request, request_length, "\"tunFileDescriptor\":42");
  assert_request_contains(request, request_length, "\"stack\":\"mixed\"");
  assert_request_contains(request, request_length, "172.19.0.1/30");
  assert_request_contains(request, request_length, "fdfe:dcba:9876::1/126");
  assert_request_contains(request, request_length, "1.1.1.1:53");
  allocate_response(response, FAKE_STATUS_RUNNING, start_status);
  return start_status;
}

static int32_t fake_stop(uint8_t *request, uint64_t request_length,
                         MishCoreBufferV1 *response) {
  stop_calls++;
  assert_request_contains(request, request_length, "\"sessionId\":\"session-1\"");
  allocate_response(response, FAKE_STATUS_UNLOADED, stop_status);
  return stop_status;
}

static int32_t fake_snapshot(uint8_t *request, uint64_t request_length,
                             MishCoreBufferV1 *response) {
  snapshot_calls++;
  assert(request != NULL);
  assert(request_length == strlen("{\"kind\":\"status\",\"limit\":1}"));
  allocate_response(response, snapshot_envelope, snapshot_status);
  return snapshot_status;
}

static void fake_free(MishCoreBufferV1 *buffer) {
  free_calls++;
  assert(buffer != NULL);
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0;
}

static MishVpnCoreValidationApi api(void) {
  MishVpnCoreValidationApi value = {
      .abi_version = fake_abi_version,
      .initialize = fake_initialize,
      .validate_config = fake_validate,
      .load_config = fake_load,
      .start = fake_start,
      .stop = fake_stop,
      .snapshot = fake_snapshot,
      .free_buffer = fake_free,
  };
  return value;
}

static void reset_fake(void) {
  abi_version = MISH_CORE_ABI_VERSION_V1;
  initialize_calls = 0;
  validate_calls = 0;
  load_calls = 0;
  start_calls = 0;
  stop_calls = 0;
  snapshot_calls = 0;
  free_calls = 0;
  initialize_status = MISH_CORE_OK_V1;
  validate_status = MISH_CORE_OK_V1;
  load_status = MISH_CORE_OK_V1;
  start_status = MISH_CORE_OK_V1;
  stop_status = MISH_CORE_OK_V1;
  snapshot_status = MISH_CORE_OK_V1;
  initialize_envelope = FAKE_VALID_INITIALIZATION;
  validate_envelope = FAKE_VALID_CONFIG;
  load_envelope = FAKE_VALID_LOAD;
  snapshot_envelope = FAKE_STATUS_UNLOADED;
}

int main(void) {
  uint8_t config[] = "mode: rule\nproxies: []\nrules: []\n";
  const int32_t mapped_statuses[] = {
      MISH_CORE_INVALID_ARGUMENT_V1, MISH_CORE_NOT_INITIALIZED_V1,
      MISH_CORE_NOT_LOADED_V1,       MISH_CORE_CONFIG_REJECTED_V1,
      MISH_CORE_CONFLICT_V1,         MISH_CORE_LIMIT_EXCEEDED_V1,
      MISH_CORE_UNSUPPORTED_V1,      MISH_CORE_FAILURE_V1,
  };
  const int32_t mapped_codes[] = {
      MISH_VPN_VALIDATION_CONFIG_REJECTED,
      MISH_VPN_VALIDATION_INITIALIZATION_FAILED,
      MISH_VPN_VALIDATION_NATIVE_FAILED,
      MISH_VPN_VALIDATION_CONFIG_REJECTED,
      MISH_VPN_VALIDATION_NATIVE_FAILED,
      MISH_VPN_VALIDATION_CONFIG_TOO_LARGE,
      MISH_VPN_VALIDATION_CORE_UNAVAILABLE,
      MISH_VPN_VALIDATION_NATIVE_FAILED,
  };
  MishVpnCoreValidationApi fixture_api = api();
  MishVpnCoreValidationResult validation;
  MishVpnCoreLoadResult loaded;
  MishVpnCoreInspectionResult inspection;
  MishVpnCoreRuntimeResult runtime;
  MishCorePlatformV1 platform = {
      .struct_size = sizeof(MishCorePlatformV1),
      .protect_socket = fake_protect_socket,
      .user_data = NULL,
  };
  MishVpnCoreLifecycleAuthority start_authority = {
      .machine_authority = "mobile-authority",
      .scope_epoch = 1,
      .operation_id = "start-op",
      .admitted_revision = 1,
      .effect_identity = "1",
  };
  MishVpnCoreLifecycleAuthority stop_authority = {
      .machine_authority = "mobile-authority",
      .scope_epoch = 1,
      .operation_id = "stop-op",
      .admitted_revision = 2,
      .effect_identity = "1",
  };
  size_t status_index;
  int initialized = 0;

  reset_fake();
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_VALID);
  assert(validation.abi_status == MISH_CORE_OK_V1);
  assert(initialized == 1);
  assert(initialize_calls == 1);
  assert(validate_calls == 1);
  assert(free_calls == 2);

  validation = mish_vpn_validate_config(
      &fixture_api, &initialized, config, sizeof(config) - 1,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert(validation.code == MISH_VPN_VALIDATION_MALFORMED_RESPONSE);
  assert(validate_calls == 2);
  assert(free_calls == 3);

  validate_status = MISH_CORE_CONFIG_REJECTED_V1;
  validate_envelope = FAKE_ERROR;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_CONFIG_REJECTED);
  assert(validate_calls == 3);
  assert(free_calls == 4);

  validate_status = MISH_CORE_OK_V1;
  validate_envelope = FAKE_MALFORMED;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_MALFORMED_RESPONSE);
  assert(free_calls == 5);

  validate_envelope = FAKE_OVERSIZED;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_RESPONSE_TOO_LARGE);
  assert(free_calls == 6);

  reset_fake();
  validation = mish_vpn_validate_config(
      &fixture_api, &initialized, config, MISH_CORE_MAX_CONFIG_BYTES_V1 + 1ULL,
      expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_CONFIG_TOO_LARGE);
  assert(initialize_calls == 0);
  assert(validate_calls == 0);
  assert(free_calls == 0);

  reset_fake();
  initialized = 0;
  initialize_envelope = FAKE_MALFORMED;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_MALFORMED_RESPONSE);
  assert(initialize_calls == 1);
  assert(validate_calls == 0);
  assert(free_calls == 1);

  reset_fake();
  initialized = 0;
  initialize_status = MISH_CORE_FAILURE_V1;
  initialize_envelope = FAKE_ERROR;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_INITIALIZATION_FAILED);
  assert(free_calls == 1);

  reset_fake();
  initialized = 0;
  abi_version = 2;
  validation =
      mish_vpn_validate_config(&fixture_api, &initialized, config,
                               sizeof(config) - 1, expected_digest);
  assert(validation.code == MISH_VPN_VALIDATION_CORE_UNAVAILABLE);
  assert(initialize_calls == 0);
  assert(validate_calls == 0);
  assert(free_calls == 0);

  reset_fake();
  initialized = 1;
  for (status_index = 0;
       status_index < sizeof(mapped_statuses) / sizeof(mapped_statuses[0]);
       status_index++) {
    validate_status = mapped_statuses[status_index];
    validate_envelope = FAKE_ERROR;
    initialized = 1;
    validation = mish_vpn_validate_config(&fixture_api, &initialized, config,
                                          sizeof(config) - 1, expected_digest);
    assert(validation.code == mapped_codes[status_index]);
    assert(validation.abi_status == mapped_statuses[status_index]);
    assert(free_calls == (int)status_index + 1);
  }

  reset_fake();
  initialized = 1;
  loaded = mish_vpn_load_config(&fixture_api, initialized, config,
                                sizeof(config) - 1, expected_digest);
  assert(loaded.code == MISH_VPN_LOAD_LOADED);
  assert(loaded.rollback_guaranteed == 0);
  assert(load_calls == 1);
  assert(free_calls == 1);

  load_status = MISH_CORE_CONFIG_REJECTED_V1;
  load_envelope = FAKE_ERROR;
  loaded = mish_vpn_load_config(&fixture_api, initialized, config,
                                sizeof(config) - 1, expected_digest);
  assert(loaded.code == MISH_VPN_LOAD_CONFIG_REJECTED);
  assert(loaded.rollback_guaranteed == 1);
  assert(free_calls == 2);

  load_status = MISH_CORE_OK_V1;
  load_envelope = FAKE_MALFORMED;
  loaded = mish_vpn_load_config(&fixture_api, initialized, config,
                                sizeof(config) - 1, expected_digest);
  assert(loaded.code == MISH_VPN_LOAD_MALFORMED_RESPONSE);
  assert(loaded.rollback_guaranteed == 0);
  assert(free_calls == 3);

  reset_fake();
  inspection =
      mish_vpn_inspect_loaded_config(&fixture_api, 0, expected_digest);
  assert(inspection.code == MISH_VPN_INSPECTION_UNLOADED);
  assert(snapshot_calls == 0);
  assert(free_calls == 0);

  inspection =
      mish_vpn_inspect_loaded_config(&fixture_api, 1, expected_digest);
  assert(inspection.code == MISH_VPN_INSPECTION_UNLOADED);
  assert(snapshot_calls == 1);
  assert(free_calls == 1);

  snapshot_envelope = FAKE_STATUS_LOADED;
  inspection =
      mish_vpn_inspect_loaded_config(&fixture_api, 1, expected_digest);
  assert(inspection.code == MISH_VPN_INSPECTION_LOADED_EXPECTED);
  assert(snapshot_calls == 2);
  assert(free_calls == 2);

  inspection = mish_vpn_inspect_loaded_config(
      &fixture_api, 1,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert(inspection.code == MISH_VPN_INSPECTION_LOADED_OTHER);
  assert(free_calls == 3);

  reset_fake();
  initialized = 1;
  runtime = mish_vpn_start_core(&fixture_api, &initialized, &platform,
                                &start_authority, "session-1", 42);
  assert(runtime.code == MISH_VPN_RUNTIME_MALFORMED_RESPONSE);
  assert(initialized == 0);
  assert(initialize_calls == 1);
  assert(start_calls == 0);
  assert(free_calls == 1);

  reset_fake();
  initialized = 1;
  initialize_envelope = FAKE_STATUS_LOADED;
  runtime = mish_vpn_start_core(&fixture_api, &initialized, &platform,
                                &start_authority, "session-1", 42);
  assert(runtime.code == MISH_VPN_RUNTIME_RUNNING);
  assert(initialize_calls == 1);
  assert(start_calls == 1);
  assert(free_calls == 2);

  snapshot_envelope = FAKE_STATUS_RUNNING;
  runtime = mish_vpn_inspect_runtime(&fixture_api, initialized, "session-1");
  assert(runtime.code == MISH_VPN_RUNTIME_RUNNING);
  runtime = mish_vpn_inspect_runtime(&fixture_api, initialized, "session-other");
  assert(runtime.code == MISH_VPN_RUNTIME_CONFLICT);
  assert(snapshot_calls == 2);
  assert(free_calls == 4);

  runtime = mish_vpn_stop_core(&fixture_api, initialized, &stop_authority,
                               "session-1");
  assert(runtime.code == MISH_VPN_RUNTIME_INACTIVE);
  assert(stop_calls == 1);
  assert(free_calls == 5);

  puts("Android validation/load/runtime bridge fake-native contract: ok");
  return 0;
}
