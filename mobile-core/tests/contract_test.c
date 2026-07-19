#include "../abi/mish_mobile_core.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static int protected_socket = -1;

static int32_t protect_socket(int32_t socket_fd, void *user_data) {
  int *counter = user_data;
  protected_socket = socket_fd;
  *counter += 1;
  return 0;
}

static int contains(const MishCoreBufferV1 *buffer, const char *needle) {
  size_t needle_length = strlen(needle);
  size_t index;
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

static void release(MishCoreBufferV1 *buffer) {
  mish_core_free_buffer_v1(buffer);
  assert(buffer->data == NULL);
  assert(buffer->length == 0);
}

int main(void) {
  MishCoreBufferV1 response = {0};
  int protection_count = 0;
  MishCorePlatformV1 platform = {
      .struct_size = sizeof(MishCorePlatformV1),
      .protect_socket = protect_socket,
      .user_data = &protection_count,
  };
  const char *initialize = "{\"abiVersion\":1}";
  const char *valid_config =
      "mode: rule\n"
      "log-level: warning\n"
      "proxies: []\n"
      "proxy-groups: []\n"
      "rules: []\n";
  const char *forbidden_config =
      "external-controller: 127.0.0.1:9090\nproxies: []\nrules: []\n";
  const char *start =
      "{\"sessionId\":\"session-1\",\"tunFileDescriptor\":42,\"stack\":\"mixed\","
      "\"addresses\":[\"172.19.0.1/30\"],\"dnsHijack\":[\"172.19.0.2:53\"],\"mtu\":1500}";
  const char *other_start =
      "{\"sessionId\":\"session-2\",\"tunFileDescriptor\":43,\"stack\":\"mixed\","
      "\"addresses\":[\"172.19.0.1/30\"],\"dnsHijack\":[],\"mtu\":1500}";
  const char *status_snapshot = "{\"kind\":\"status\"}";
  const char *set_mode =
      "{\"operation\":\"set-routing-mode\",\"mode\":\"global\"}";
  const char *poll_events = "{\"afterSequence\":\"0\",\"limit\":16}";

  assert(mish_core_abi_version_v1() == MISH_CORE_ABI_VERSION_V1);
  assert(mish_core_version_v1(&response) == MISH_CORE_OK_V1);
  assert(contains(&response, "\"mihomoVersion\":\"v1.19.29\""));
  release(&response);

  assert(mish_core_snapshot_v1((uint8_t *)status_snapshot,
                               strlen(status_snapshot), &response) ==
         MISH_CORE_NOT_INITIALIZED_V1);
  assert(contains(&response, "not-initialized"));
  release(&response);

  assert(mish_core_initialize_v1(&platform, (uint8_t *)initialize,
                                 strlen(initialize), &response) == MISH_CORE_OK_V1);
  assert(contains(&response, "\"phase\":\"inactive\""));
  release(&response);

  assert(mish_core_validate_config_v1((uint8_t *)forbidden_config,
                                      strlen(forbidden_config), &response) ==
         MISH_CORE_CONFIG_REJECTED_V1);
  assert(contains(&response, "config-rejected"));
  release(&response);

  assert(mish_core_validate_config_v1((uint8_t *)valid_config,
                                      MISH_CORE_MAX_CONFIG_BYTES_V1 + 1ULL,
                                      &response) == MISH_CORE_LIMIT_EXCEEDED_V1);
  release(&response);

  assert(mish_core_load_config_v1((uint8_t *)valid_config, strlen(valid_config),
                                  &response) == MISH_CORE_OK_V1);
  assert(contains(&response, "\"loaded\":true"));
  release(&response);

  assert(mish_core_start_v1((uint8_t *)start, strlen(start), &response) ==
         MISH_CORE_OK_V1);
  assert(contains(&response, "\"phase\":\"running\""));
  assert(protection_count == 1);
  assert(protected_socket == 100);
  release(&response);

  assert(mish_core_start_v1((uint8_t *)start, strlen(start), &response) ==
         MISH_CORE_OK_V1);
  assert(protection_count == 1);
  release(&response);

  assert(mish_core_start_v1((uint8_t *)other_start, strlen(other_start),
                            &response) == MISH_CORE_CONFLICT_V1);
  release(&response);

  assert(mish_core_command_v1((uint8_t *)set_mode, strlen(set_mode),
                              &response) == MISH_CORE_OK_V1);
  release(&response);

  assert(mish_core_poll_events_v1((uint8_t *)poll_events,
                                  strlen(poll_events), &response) ==
         MISH_CORE_OK_V1);
  assert(contains(&response, "latestSequence"));
  release(&response);

  assert(mish_core_stop_v1((uint8_t *)"{}", 2, &response) == MISH_CORE_OK_V1);
  assert(contains(&response, "\"phase\":\"inactive\""));
  release(&response);
  assert(mish_core_stop_v1((uint8_t *)"{}", 2, &response) == MISH_CORE_OK_V1);
  release(&response);

  puts("mobile core ABI fixture contract: ok");
  return 0;
}
