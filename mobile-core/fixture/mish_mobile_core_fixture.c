#include "../abi/mish_mobile_core.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static int fixture_initialized = 0;
static int fixture_loaded = 0;
static int fixture_running = 0;
static int fixture_connection_active = 0;
static uint64_t fixture_sequence = 0;
static char fixture_session[129] = {0};
static char fixture_machine_authority[129] = {0};
static char fixture_operation_id[129] = {0};
static char fixture_effect_identity[129] = {0};
static uint64_t fixture_scope_epoch = 0;
static uint64_t fixture_admitted_revision = 0;
static char fixture_route_selected[257] = "Alpha";
static char fixture_route_operation[129] = {0};
static char fixture_route_command[MISH_CORE_MAX_REQUEST_BYTES_V1 + 1] = {0};
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

static int extract_uint64(const char *json, const char *field, uint64_t *output) {
  char needle[96];
  char *end;
  const char *start;
  unsigned long long value;
  snprintf(needle, sizeof(needle), "\"%s\":", field);
  start = strstr(json, needle);
  if (start == NULL) return 0;
  start += strlen(needle);
  value = strtoull(start, &end, 10);
  if (end == start || value == 0) return 0;
  *output = (uint64_t)value;
  return 1;
}

static int lifecycle_is_successor(const char *machine, uint64_t scope,
                                  const char *operation, uint64_t revision,
                                  const char *effect) {
  char next_effect[32];
  char *end = NULL;
  unsigned long long current_effect;
  if (fixture_scope_epoch == 0) return 1;
  if (strcmp(machine, fixture_machine_authority) != 0) return 0;
  if (scope != fixture_scope_epoch) return scope > fixture_scope_epoch;
  if (revision != fixture_admitted_revision)
    return revision > fixture_admitted_revision;
  current_effect = strtoull(fixture_effect_identity, &end, 10);
  if (end == fixture_effect_identity || *end != '\0' ||
      current_effect == ULLONG_MAX)
    return 0;
  snprintf(next_effect, sizeof(next_effect), "%llu", current_effect + 1);
  return strcmp(operation, fixture_operation_id) == 0 &&
         strcmp(effect, next_effect) == 0;
}

static void record_lifecycle(const char *machine, uint64_t scope,
                             const char *operation, uint64_t revision,
                             const char *effect) {
  strcpy(fixture_machine_authority, machine);
  strcpy(fixture_operation_id, operation);
  strcpy(fixture_effect_identity, effect);
  fixture_scope_epoch = scope;
  fixture_admitted_revision = revision;
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
      fixture_loaded ? "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"" : "null",
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
                      "{\"abiVersion\":1,\"data\":{\"configSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"valid\":true}}");
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
  char machine[129] = {0};
  char operation[129] = {0};
  char effect[129] = {0};
  uint64_t scope = 0;
  uint64_t revision = 0;
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
      !extract_string(json, "machineAuthority", machine, sizeof(machine)) ||
      !extract_uint64(json, "scopeEpoch", &scope) ||
      !extract_string(json, "operationId", operation, sizeof(operation)) ||
      !extract_uint64(json, "admittedRevision", &revision) ||
      !extract_string(json, "effectIdentity", effect, sizeof(effect)) ||
      strstr(json, "\"tunFileDescriptor\":") == NULL ||
      strstr(json, "\"addresses\":[") == NULL || strstr(json, "\"mtu\":") == NULL) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "start request is invalid");
  }
  free(json);
  if (fixture_running) {
    if (strcmp(fixture_session, session) == 0 &&
        strcmp(machine, fixture_machine_authority) == 0 &&
        scope == fixture_scope_epoch && revision == fixture_admitted_revision &&
        strcmp(operation, fixture_operation_id) == 0 &&
        strcmp(effect, fixture_effect_identity) == 0) {
      return status_response(response);
    }
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "another session is already running");
  }
  if (!lifecycle_is_successor(machine, scope, operation, revision, effect)) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "lifecycle authority is stale");
  }
  if (fixture_platform.protect_socket(100, fixture_platform.user_data) != 0) {
    return set_error(response, MISH_CORE_FAILURE_V1, "core-failure",
                     "platform rejected socket protection");
  }
  strcpy(fixture_session, session);
  record_lifecycle(machine, scope, operation, revision, effect);
  fixture_running = 1;
  fixture_connection_active = 1;
  fixture_sequence++;
  return status_response(response);
}

int32_t mish_core_stop_v1(uint8_t *request,
                          uint64_t request_length,
                          MishCoreBufferV1 *response) {
  char *json;
  char machine[129] = {0};
  char operation[129] = {0};
  char effect[129] = {0};
  uint64_t scope = 0;
  uint64_t revision = 0;
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) {
    return initialized;
  }
  json = copy_input(request, request_length, MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (json == NULL || request_length == 0 ||
      !extract_string(json, "machineAuthority", machine, sizeof(machine)) ||
      !extract_uint64(json, "scopeEpoch", &scope) ||
      !extract_string(json, "operationId", operation, sizeof(operation)) ||
      !extract_uint64(json, "admittedRevision", &revision) ||
      !extract_string(json, "effectIdentity", effect, sizeof(effect))) {
    free(json);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "stop request is invalid");
  }
  free(json);
  if (!lifecycle_is_successor(machine, scope, operation, revision, effect) &&
      !(strcmp(machine, fixture_machine_authority) == 0 &&
        scope == fixture_scope_epoch && revision == fixture_admitted_revision &&
        strcmp(operation, fixture_operation_id) == 0 &&
        strcmp(effect, fixture_effect_identity) == 0)) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "lifecycle authority is stale");
  }
  record_lifecycle(machine, scope, operation, revision, effect);
  if (fixture_running) {
    fixture_running = 0;
    fixture_connection_active = 0;
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
    char payload[1024];
    free(json);
    snprintf(payload, sizeof(payload),
             "{\"abiVersion\":1,\"data\":{\"groups\":[{\"candidates\":[\"Alpha\",\"Beta\"],\"name\":\"Proxy\",\"selected\":\"%s\"}],\"mode\":\"rule\",\"truncated\":false}}",
             fixture_route_selected);
    return set_response(response, MISH_CORE_OK_V1, payload);
  }
  if (strstr(json, "\"kind\":\"traffic\"") != NULL) {
    free(json);
    return set_response(response, MISH_CORE_OK_V1,
                        "{\"abiVersion\":1,\"data\":{\"downloadBytesPerSecond\":\"0\",\"downloadTotalBytes\":\"0\",\"memoryBytes\":\"0\",\"uploadBytesPerSecond\":\"0\",\"uploadTotalBytes\":\"0\"}}");
  }
  if (strstr(json, "\"kind\":\"connections\"") != NULL) {
    free(json);
    char payload[2048];
    snprintf(
        payload, sizeof(payload),
        "{\"abiVersion\":1,\"data\":{\"connections\":%s,\"eventSequence\":\"%llu\",\"running\":%s,\"sessionId\":\"%s\",\"truncated\":false}}",
        fixture_connection_active
            ? "[{\"destinationHost\":\"traffic.fixture.invalid\",\"destinationIp\":\"192.0.2.44\",\"destinationPort\":443,\"downloadBytes\":\"2048\",\"id\":\"fixture-connection-current\",\"matchedRulePayload\":\"fixture.invalid\",\"matchedRuleType\":\"DomainSuffix\",\"network\":\"tcp\",\"processName\":\"Fixture App\",\"protocol\":\"Tun\",\"providerChain\":[],\"remoteDestination\":null,\"routeChain\":[\"Fixture Group\",\"Fixture Exit\"],\"sniffHost\":null,\"sourcePort\":40000,\"startedAt\":\"2026-08-13T00:00:00Z\",\"uploadBytes\":\"1024\"}]"
            : "[]",
        (unsigned long long)fixture_sequence, fixture_running ? "true" : "false",
        fixture_session);
    return set_response(response, MISH_CORE_OK_V1, payload);
  }
  free(json);
  return set_error(response, MISH_CORE_UNSUPPORTED_V1, "unsupported",
                   "snapshot kind is unsupported");
}

int32_t mish_core_command_v1(uint8_t *request,
                             uint64_t request_length,
                             MishCoreBufferV1 *response) {
  char *json;
  char operation[129] = {0};
  char runtime_authority[129] = {0};
  char profile_id[129] = {0};
  char profile_revision[129] = {0};
  char group_id[129] = {0};
  char current_child_id[129] = {0};
  char child_id[129] = {0};
  char group[257] = {0};
  char current_child[257] = {0};
  char selection[257] = {0};
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
  if (strstr(json, "\"operation\":\"select-policy\"") != NULL) {
    if (!extract_string(json, "operationId", operation, sizeof(operation)) ||
        !extract_string(json, "runtimeAuthority", runtime_authority,
                        sizeof(runtime_authority)) ||
        !extract_string(json, "profileId", profile_id, sizeof(profile_id)) ||
        !extract_string(json, "profileRevision", profile_revision,
                        sizeof(profile_revision)) ||
        !extract_string(json, "groupId", group_id, sizeof(group_id)) ||
        !extract_string(json, "currentChildId", current_child_id,
                        sizeof(current_child_id)) ||
        !extract_string(json, "childId", child_id, sizeof(child_id)) ||
        !extract_string(json, "group", group, sizeof(group)) ||
        !extract_string(json, "currentChild", current_child,
                        sizeof(current_child)) ||
        !extract_string(json, "selection", selection, sizeof(selection))) {
      free(json);
      return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1,
                       "invalid-argument", "policy selection is invalid");
    }
    if (strcmp(runtime_authority, fixture_machine_authority) != 0) {
      free(json);
      return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                       "runtime authority is stale");
    }
    if (strcmp(operation, fixture_route_operation) == 0) {
      int duplicate = strcmp(json, fixture_route_command) == 0;
      free(json);
      if (!duplicate) {
        return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                         "operation identity conflicts with a prior command");
      }
      return status_response(response);
    }
    if (strcmp(group, "Proxy") != 0 ||
        strcmp(current_child, fixture_route_selected) != 0 ||
        (strcmp(selection, "Alpha") != 0 && strcmp(selection, "Beta") != 0)) {
      free(json);
      return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                       "policy relation is stale");
    }
    strcpy(fixture_route_operation, operation);
    strcpy(fixture_route_command, json);
    strcpy(fixture_route_selected, selection);
  }
  if (strstr(json, "\"operation\":\"close-connection\"") != NULL) {
    char connection[129] = {0};
    if (!extract_string(json, "connectionId", connection, sizeof(connection)) ||
        !fixture_connection_active ||
        strcmp(connection, "fixture-connection-current") != 0) {
      free(json);
      return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1,
                       "invalid-argument", "connection was not found");
    }
    fixture_connection_active = 0;
  }
  free(json);
  fixture_sequence++;
  return status_response(response);
}

int32_t mish_core_close_connection_v1(uint8_t *connection_id,
                                      uint64_t connection_id_length,
                                      MishCoreBufferV1 *response) {
  char *connection;
  char connection_value[129] = {0};
  char session_value[129] = {0};
  char sequence_value[32] = {0};
  char payload[2048];
  const char *failure = "null";
  int32_t initialized = require_initialized(response);
  if (initialized != MISH_CORE_OK_V1) return initialized;
  if (!fixture_running) {
    return set_error(response, MISH_CORE_CONFLICT_V1, "conflict",
                     "commands require a running Core");
  }
  connection = copy_input(connection_id, connection_id_length,
                          MISH_CORE_MAX_REQUEST_BYTES_V1);
  if (connection == NULL || connection_id_length == 0 ||
      !extract_string(connection, "connectionId", connection_value,
                      sizeof(connection_value)) ||
      !extract_string(connection, "eventSequence", sequence_value,
                      sizeof(sequence_value)) ||
      !extract_string(connection, "sessionId", session_value,
                      sizeof(session_value))) {
    free(connection);
    return set_error(response, MISH_CORE_INVALID_ARGUMENT_V1, "invalid-argument",
                     "connection identifier is invalid");
  }
  char expected_sequence[32];
  snprintf(expected_sequence, sizeof(expected_sequence), "%llu",
           (unsigned long long)fixture_sequence);
  if (strcmp(session_value, fixture_session) != 0 ||
      strcmp(sequence_value, expected_sequence) != 0 ||
      !fixture_connection_active ||
      strcmp(connection_value, "fixture-connection-current") != 0) {
    failure = "\"stale-connection\"";
  } else {
    fixture_connection_active = 0;
    fixture_sequence++;
  }
  free(connection);
  snprintf(payload, sizeof(payload),
           "{\"abiVersion\":1,\"data\":{\"failure\":%s,\"snapshot\":{\"connections\":[],\"eventSequence\":\"%llu\",\"running\":true,\"sessionId\":\"%s\",\"truncated\":false}}}",
           failure, (unsigned long long)fixture_sequence, fixture_session);
  return set_response(response, MISH_CORE_OK_V1, payload);
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
