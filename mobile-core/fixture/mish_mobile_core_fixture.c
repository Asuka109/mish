#include "../abi/mish_mobile_core.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fixture_initialized = 0;
static int fixture_loaded = 0;
static int fixture_running = 0;
static uint64_t fixture_sequence = 0;
static char fixture_session[129] = {0};
static MishCorePlatformV1 fixture_platform = {0};

static int32_t set_response(MishCoreBufferV1 *response, int32_t status,
                            const char *json) {
  size_t length;
  if (response == NULL) {
    return MISH_CORE_INVALID_ARGUMENT_V1;
  }
  response->data = NULL;
  response->length = 0;
  length = strlen(json);
  response->data = malloc(length);
  if (response->data == NULL && length != 0) {
    return MISH_CORE_FAILURE_V1;
  }
  if (length != 0) {
    memcpy(response->data, json, length);
  }
  response->length = length;
  return status;
}

static int32_t set_error(MishCoreBufferV1 *response, int32_t status,
                         const char *code, const char *message) {
  char json[768];
  snprintf(json, sizeof(json),
           "{\"abiVersion\":1,\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}",
           code, message);
  return set_response(response, status, json);
}

static char *copy_input(const uint8_t *input, uint64_t length, uint64_t maximum) {
  char *copy;
  if (length > maximum || (input == NULL && length != 0)) {
    return NULL;
  }
  copy = calloc((size_t)length + 1, 1);
  if (copy == NULL) {
    return NULL;
  }
  if (length != 0) {
    memcpy(copy, input, (size_t)length);
  }
  return copy;
}

static int extract_string(const char *json, const char *field, char *output,
                          size_t output_size) {
  char needle[96];
  const char *start;
  const char *end;
  size_t length;
  snprintf(needle, sizeof(needle), "\"%s\":\"", field);
  start = strstr(json, needle);
  if (start == NULL) {
    return 0;
  }
  start += strlen(needle);
  end = strchr(start, '"');
  if (end == NULL) {
    return 0;
  }
  length = (size_t)(end - start);
  if (length == 0 || length >= output_size) {
    return 0;
  }
  memcpy(output, start, length);
  output[length] = '\0';
  return 1;
}

static int32_t require_initialized(MishCoreBufferV1 *response) {
  if (fixture_initialized) {
    return MISH_CORE_OK_V1;
  }
  return set_error(response, MISH_CORE_NOT_INITIALIZED_V1, "not-initialized",
                   "core is not initialized");
}

static int32_t status_response(MishCoreBufferV1 *response) {
  char json[1024];
  snprintf(
      json, sizeof(json),
      "{\"abiVersion\":1,\"data\":{\"configSha256\":%s,\"eventSequence\":\"%llu\",\"loaded\":%s,\"mode\":\"rule\",\"phase\":\"%s\",\"sessionId\":%s%s%s}}",
      fixture_loaded ? "\"fixture-config-sha256\"" : "null",
      (unsigned long long)fixture_sequence, fixture_loaded ? "true" : "false",
      fixture_running ? "running" : "inactive",
      fixture_running ? "\"" : "null", fixture_running ? fixture_session : "",
      fixture_running ? "\"" : "");
  return set_response(response, MISH_CORE_OK_V1, json);
}

uint32_t mish_core_abi_version_v1(void) { return MISH_CORE_ABI_VERSION_V1; }

int32_t mish_core_initialize_v1(MishCorePlatformV1 *platform, uint8_t *request,
                                uint64_t request_length,
                                MishCoreBufferV1 *response) {
  char *json;
  if (platform == NULL || platform->struct_size < sizeof(MishCorePlatformV1) ||
      platform->protect_socket == NULL) {
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "platform callback table is incomplete");
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL || strstr(json, "\"abiVersion\":1") == NULL) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "initialize request is invalid");
  }
  free(json);
  if (fixture_running) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "platform callbacks cannot change while running");
  }
  fixture_platform = *platform;
  fixture_initialized = 1;
  return status_response(response);
}

int32_t mish_core_version_v1(MishCoreBufferV1 *response) {
  return set_response(
      response, MISH_CORE_OK_V1,
      "{\"abiVersion\":1,\"data\":{\"abiVersion\":1,\"goVersion\":\"fixture\",\"mihomoCommit\":\"e26714a181ac0e2fa803453c0a8e9a9ce94e31cb\",\"mihomoVersion\":\"v1.19.29\",\"wrapperRevision\":\"mish-mobile-core-fixture-v1\"}}");
}

int32_t mish_core_validate_config_v1(uint8_t *config,
                                     uint64_t config_length,
                                     MishCoreBufferV1 *response) {
  char *yaml;
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  if (config_length > MISH_CORE_MAX_CONFIG_BYTES_V1) {
    return set_error(response, MISH_CORE_LIMIT_EXCEEDED_V1, "limit-exceeded",
                     "configuration exceeds the ABI limit");
  }
  yaml = copy_input(config, config_length, MISH_CORE_MAX_CONFIG_BYTES_V1);
  if (yaml == NULL || config_length == 0 || strstr(yaml, "external-controller") != NULL ||
      strstr(yaml, "proxy-providers:") != NULL || strstr(yaml, "tun:\n  enable: true") != NULL) {
    free(yaml);
    return set_error(response, MISH_CORE_CONFIG_REJECTED_V1, "config-rejected",
                     "configuration is invalid or violates the mobile boundary");
  }
  free(yaml);
  return set_response(response, MISH_CORE_OK_V1,
                      "{\"abiVersion\":1,\"data\":{\"configSha256\":\"fixture-config-sha256\",\"valid\":true}}");
}

int32_t mish_core_load_config_v1(uint8_t *config,
                                 uint64_t config_length,
                                 MishCoreBufferV1 *response) {
  MishCoreBufferV1 validation = {0};
  int32_t status = mish_core_validate_config_v1(config, config_length, &validation);
  mish_core_free_buffer_v1(&validation);
  if (status != MISH_CORE_OK_V1) {
    return set_error(response, status, status == MISH_CORE_LIMIT_EXCEEDED_V1 ? "limit-exceeded" : "config-rejected",
                     "configuration is invalid or violates the mobile boundary");
  }
  if (fixture_running) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "configuration cannot change while running");
  }
  fixture_loaded = 1;
  fixture_sequence++;
  return status_response(response);
}

int32_t mish_core_start_v1(uint8_t *request,
                           uint64_t request_length,
                           MishCoreBufferV1 *response) {
  char *json;
  char session[129] = {0};
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  if (!fixture_loaded) {
    return set_error(response, MISH_CORE_NOT_LOADED_V1, "not-loaded",
                     "configuration must be loaded before start");
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL || !extract_string(json, "sessionId", session, sizeof(session)) ||
      strstr(json, "\"tunFileDescriptor\":") == NULL ||
      strstr(json, "\"addresses\":[") == NULL || strstr(json, "\"mtu\":") == NULL) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "start request is invalid");
  }
  free(json);
  if (fixture_running) {
    if (strcmp(fixture_session, session) == 0) {
      return status_response(response);
    }
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "another session is already running");
  }
  if (fixture_platform.protect_socket(100, fixture_platform.user_data) != 0) {
    return set_error(response, MISH_CORE_FAILURE_V1, "core-failure",
                     "platform rejected socket protection");
  }
  strcpy(fixture_session, session);
  fixture_running = 1;
  fixture_sequence++;
  return status_response(response);
}

int32_t mish_core_stop_v1(uint8_t *request,
                          uint64_t request_length,
                          MishCoreBufferV1 *response) {
  char *json;
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL || request_length == 0) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "stop request is invalid");
  }
  free(json);
  if (fixture_running) {
    fixture_running = 0;
    fixture_session[0] = '\0';
    fixture_sequence++;
  }
  return status_response(response);
}

int32_t mish_core_snapshot_v1(uint8_t *request,
                              uint64_t request_length,
                              MishCoreBufferV1 *response) {
  char *json;
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL) {
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "snapshot request is invalid");
  }
  if (strstr(json, "\"kind\":\"status\"") != NULL) {
    free(json);
    return status_response(response);
  }
  if (strstr(json, "\"kind\":\"routes\"") != NULL) {
    free(json);
    return set_response(response, MISH_CORE_OK_V1,
                        "{\"abiVersion\":1,\"data\":{\"groups\":[],\"mode\":\"rule\",\"truncated\":false}}");
  }
  if (strstr(json, "\"kind\":\"traffic\"") != NULL) {
    free(json);
    return set_response(response, MISH_CORE_OK_V1,
                        "{\"abiVersion\":1,\"data\":{\"downloadBytesPerSecond\":\"0\",\"downloadTotalBytes\":\"0\",\"memoryBytes\":\"0\",\"uploadBytesPerSecond\":\"0\",\"uploadTotalBytes\":\"0\"}}");
  }
  if (strstr(json, "\"kind\":\"connections\"") != NULL) {
    free(json);
    return set_response(response, MISH_CORE_OK_V1,
                        "{\"abiVersion\":1,\"data\":{\"connections\":[],\"truncated\":false}}");
  }
  free(json);
  return set_error(response, MISH_CORE_UNSUPPORTED_V1, "unsupported",
                   "snapshot kind is unsupported");
}

int32_t mish_core_command_v1(uint8_t *request,
                             uint64_t request_length,
                             MishCoreBufferV1 *response) {
  char *json;
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  if (!fixture_running) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "commands require a running Core");
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL) {
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "command request is invalid");
  }
  if (strstr(json, "\"operation\":\"set-routing-mode\"") == NULL &&
      strstr(json, "\"operation\":\"select-policy\"") == NULL &&
      strstr(json, "\"operation\":\"close-connection\"") == NULL &&
      strstr(json, "\"operation\":\"close-all-connections\"") == NULL) {
    free(json);
    return set_error(response, MISH_CORE_UNSUPPORTED_V1, "unsupported",
                     "command operation is unsupported");
  }
  free(json);
  fixture_sequence++;
  return status_response(response);
}

int32_t mish_core_poll_events_v1(uint8_t *request,
                                 uint64_t request_length,
                                 MishCoreBufferV1 *response) {
  char *json;
  char payload[1024];
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL || strstr(json, "\"afterSequence\":\"") == NULL) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "event request is invalid");
  }
  free(json);
  snprintf(payload, sizeof(payload),
           "{\"abiVersion\":1,\"data\":{\"events\":[],\"gap\":false,\"latestSequence\":\"%llu\",\"oldestSequence\":\"0\"}}",
           (unsigned long long)fixture_sequence);
  return set_response(response, MISH_CORE_OK_V1, payload);
}

void mish_core_free_buffer_v1(MishCoreBufferV1 *buffer) {
  if (buffer == NULL) {
    return;
  }
  free(buffer->data);
  buffer->data = NULL;
  buffer->length = 0;
}
