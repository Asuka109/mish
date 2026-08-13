#include <dlfcn.h>
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mish_mobile_core.h"
#include "mish_vpn_core_validation.h"

typedef int32_t (*MishCoreVersionFn)(MishCoreBufferV1 *response);

static pthread_once_t core_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t core_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t protect_mutex = PTHREAD_MUTEX_INITIALIZER;
static void *core_handle = NULL;
static MishVpnCoreValidationApi core_api = {0};
static MishCoreVersionFn core_version = NULL;
static int core_initialized = 0;
static JavaVM *java_vm = NULL;
static jobject vpn_service = NULL;

static void log_bounded_runtime_failure(MishVpnCoreRuntimeResult result) {
  if (result.code == MISH_VPN_RUNTIME_RUNNING) {
    return;
  }
  __android_log_print(ANDROID_LOG_WARN, "MishVpnRuntime",
                      "Mobile Core start rejected: runtime_code=%d abi_status=%d",
                      result.code, result.abi_status);
}

static int32_t protect_socket_with_service(int32_t socket_fd, void *user_data) {
  JNIEnv *environment = NULL;
  jclass service_class;
  jmethodID protect_method;
  jboolean protected;
  int attached = 0;
  (void)user_data;
  pthread_mutex_lock(&protect_mutex);
  if (java_vm == NULL || vpn_service == NULL) {
    pthread_mutex_unlock(&protect_mutex);
    return -1;
  }
  if ((*java_vm)->GetEnv(java_vm, (void **)&environment, JNI_VERSION_1_6) !=
      JNI_OK) {
    if ((*java_vm)->AttachCurrentThread(java_vm, &environment, NULL) != JNI_OK) {
      pthread_mutex_unlock(&protect_mutex);
      return -1;
    }
    attached = 1;
  }
  service_class = (*environment)->GetObjectClass(environment, vpn_service);
  if (service_class == NULL) {
    if (attached) {
      (*java_vm)->DetachCurrentThread(java_vm);
    }
    pthread_mutex_unlock(&protect_mutex);
    return -1;
  }
  protect_method = (*environment)->GetMethodID(environment, service_class,
                                               "protectSocket", "(I)Z");
  (*environment)->DeleteLocalRef(environment, service_class);
  if (protect_method == NULL) {
    if ((*environment)->ExceptionCheck(environment)) {
      (*environment)->ExceptionClear(environment);
    }
    if (attached) {
      (*java_vm)->DetachCurrentThread(java_vm);
    }
    pthread_mutex_unlock(&protect_mutex);
    return -1;
  }
  protected = (*environment)->CallBooleanMethod(environment, vpn_service,
                                                protect_method, socket_fd);
  if ((*environment)->ExceptionCheck(environment)) {
    (*environment)->ExceptionClear(environment);
    protected = JNI_FALSE;
  }
  if (attached) {
    (*java_vm)->DetachCurrentThread(java_vm);
  }
  pthread_mutex_unlock(&protect_mutex);
  return protected == JNI_TRUE ? 0 : -1;
}

static jintArray runtime_array(JNIEnv *environment,
                               MishVpnCoreRuntimeResult result) {
  jint encoded[2] = {result.code, result.abi_status};
  jintArray array = (*environment)->NewIntArray(environment, 2);
  if (array != NULL) {
    (*environment)->SetIntArrayRegion(environment, array, 0, 2, encoded);
  }
  return array;
}

static int closed_identifier(const char *value, size_t maximum) {
  size_t length;
  size_t index;
  if (value == NULL) return 0;
  length = strlen(value);
  if (length == 0 || length > maximum) return 0;
  for (index = 0; index < length; index++) {
    char character = value[index];
    if (!((character >= 'a' && character <= 'z') ||
          (character >= 'A' && character <= 'Z') ||
          (character >= '0' && character <= '9') || character == '-' ||
          character == '_' || character == '.')) {
      return 0;
    }
  }
  return 1;
}

static int decimal_identifier(const char *value, size_t maximum) {
  size_t length;
  size_t index;
  if (value == NULL) return 0;
  length = strlen(value);
  if (length == 0 || length > maximum) return 0;
  for (index = 0; index < length; index++) {
    if (value[index] < '0' || value[index] > '9') return 0;
  }
  return 1;
}

static void load_core(void) {
  core_handle = dlopen("libmish_mobile_core.so", RTLD_NOW | RTLD_LOCAL);
  if (core_handle == NULL) {
    return;
  }
  core_api.abi_version =
      (MishVpnCoreAbiVersionFn)dlsym(core_handle, "mish_core_abi_version_v1");
  core_api.initialize =
      (MishVpnCoreInitializeFn)dlsym(core_handle, "mish_core_initialize_v1");
  core_api.validate_config = (MishVpnCoreValidateConfigFn)dlsym(
      core_handle, "mish_core_validate_config_v1");
  core_api.load_config =
      (MishVpnCoreLoadConfigFn)dlsym(core_handle, "mish_core_load_config_v1");
  core_api.start =
      (MishVpnCoreStartFn)dlsym(core_handle, "mish_core_start_v1");
  core_api.stop = (MishVpnCoreStopFn)dlsym(core_handle, "mish_core_stop_v1");
  core_api.snapshot =
      (MishVpnCoreSnapshotFn)dlsym(core_handle, "mish_core_snapshot_v1");
  core_api.command =
      (MishVpnCoreCommandFn)dlsym(core_handle, "mish_core_command_v1");
  core_api.close_connection = (MishVpnCoreCloseConnectionFn)dlsym(
      core_handle, "mish_core_close_connection_v1");
  core_api.free_buffer =
      (MishVpnCoreFreeBufferFn)dlsym(core_handle, "mish_core_free_buffer_v1");
  core_version = (MishCoreVersionFn)dlsym(core_handle, "mish_core_version_v1");
  if (core_api.abi_version == NULL || core_api.initialize == NULL ||
      core_api.validate_config == NULL || core_api.free_buffer == NULL ||
      core_api.load_config == NULL || core_api.snapshot == NULL ||
      core_api.command == NULL ||
      core_api.close_connection == NULL ||
      core_api.start == NULL || core_api.stop == NULL ||
      core_version == NULL) {
    memset(&core_api, 0, sizeof(core_api));
    core_version = NULL;
  }
}

static jbyteArray bytes(JNIEnv *environment, const uint8_t *data,
                        uint64_t length) {
  jbyteArray result;
  if (data == NULL || length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    return NULL;
  }
  result = (*environment)->NewByteArray(environment, (jsize)length);
  if (result != NULL && length != 0) {
    (*environment)->SetByteArrayRegion(environment, result, 0, (jsize)length,
                                       (const jbyte *)data);
  }
  return result;
}

static jbyteArray buffer_bytes(JNIEnv *environment, MishCoreBufferV1 *buffer) {
  if (buffer->data == NULL || buffer->length == 0 ||
      buffer->length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    return NULL;
  }
  return bytes(environment, buffer->data, buffer->length);
}

JNIEXPORT jobjectArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeRouteOperation(
    JNIEnv *environment, jobject instance, jstring command_json) {
  static const char status_request[] = "{\"kind\":\"status\"}";
  static const char routes_request[] = "{\"kind\":\"routes\",\"limit\":512}";
  MishCoreBufferV1 command_response = {0};
  MishCoreBufferV1 status_response = {0};
  MishCoreBufferV1 routes_response = {0};
  int32_t command_status = MISH_CORE_OK_V1;
  int32_t status_status = MISH_CORE_FAILURE_V1;
  int32_t routes_status = MISH_CORE_FAILURE_V1;
  const char *command_request = NULL;
  jobjectArray output = NULL;
  jclass byte_array_class = NULL;
  char status_number[16];
  char routes_number[16];
  char command_number[16];
  jbyteArray values[6] = {NULL, NULL, NULL, NULL, NULL, NULL};
  (void)instance;
  pthread_once(&core_once, load_core);
  if (core_api.snapshot == NULL || core_api.command == NULL ||
      core_api.free_buffer == NULL) {
    return NULL;
  }
  if (command_json != NULL) {
    command_request =
        (*environment)->GetStringUTFChars(environment, command_json, NULL);
    if (command_request == NULL || strlen(command_request) == 0 ||
        strlen(command_request) > MISH_CORE_MAX_REQUEST_BYTES_V1) {
      goto cleanup;
    }
  }
  pthread_mutex_lock(&core_mutex);
  if (command_request != NULL) {
    command_status = core_api.command((uint8_t *)command_request,
                                      (uint64_t)strlen(command_request),
                                      &command_response);
  }
  status_status = core_api.snapshot((uint8_t *)status_request,
                                    sizeof(status_request) - 1, &status_response);
  routes_status = core_api.snapshot((uint8_t *)routes_request,
                                    sizeof(routes_request) - 1, &routes_response);
  pthread_mutex_unlock(&core_mutex);

  byte_array_class = (*environment)->FindClass(environment, "[B");
  if (byte_array_class == NULL) {
    goto cleanup;
  }
  output = (*environment)->NewObjectArray(environment, 6, byte_array_class, NULL);
  if (output == NULL) {
    goto cleanup;
  }
  snprintf(command_number, sizeof(command_number), "%d", command_status);
  snprintf(status_number, sizeof(status_number), "%d", status_status);
  snprintf(routes_number, sizeof(routes_number), "%d", routes_status);
  values[0] = bytes(environment, (const uint8_t *)command_number,
                    strlen(command_number));
  values[1] = command_request == NULL
                  ? bytes(environment, (const uint8_t *)"", 0)
                  : buffer_bytes(environment, &command_response);
  values[2] = bytes(environment, (const uint8_t *)status_number,
                    strlen(status_number));
  values[3] = buffer_bytes(environment, &status_response);
  values[4] = bytes(environment, (const uint8_t *)routes_number,
                    strlen(routes_number));
  values[5] = buffer_bytes(environment, &routes_response);
  for (int index = 0; index < 6; index++) {
    if (values[index] == NULL) {
      output = NULL;
      goto cleanup;
    }
    (*environment)->SetObjectArrayElement(environment, output, index, values[index]);
  }

cleanup:
  core_api.free_buffer(&command_response);
  core_api.free_buffer(&status_response);
  core_api.free_buffer(&routes_response);
  if (command_request != NULL) {
    (*environment)->ReleaseStringUTFChars(environment, command_json,
                                          command_request);
  }
  for (int index = 0; index < 6; index++) {
    if (values[index] != NULL) {
      (*environment)->DeleteLocalRef(environment, values[index]);
    }
  }
  if (byte_array_class != NULL) {
    (*environment)->DeleteLocalRef(environment, byte_array_class);
  }
  return output;
}

static jstring invoke_json_envelope(JNIEnv *environment,
                                    int32_t (*operation)(uint8_t *, uint64_t,
                                                         MishCoreBufferV1 *),
                                    const char *request) {
  MishCoreBufferV1 response = {0};
  jstring result = NULL;
  char *text = NULL;
  if (operation == NULL || request == NULL || core_api.free_buffer == NULL) {
    return NULL;
  }
  int32_t status = operation((uint8_t *)request, strlen(request), &response);
  if (response.data == NULL || response.length == 0 ||
      response.length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    goto cleanup;
  }
  text = malloc((size_t)response.length + 1);
  if (text != NULL) {
    memcpy(text, response.data, (size_t)response.length);
    text[response.length] = '\0';
  }
cleanup:
  /* Every native response buffer crosses this cleanup point exactly once. */
  core_api.free_buffer(&response);
  if (text == NULL) {
    return NULL;
  }
  if (status >= MISH_CORE_OK_V1 && status <= MISH_CORE_FAILURE_V1) {
    result = (*environment)->NewStringUTF(environment, text);
  }
  free(text);
  return result;
}

JNIEXPORT jstring JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeTrafficSnapshot(
    JNIEnv *environment, jobject instance) {
  jstring result;
  (void)instance;
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  result = invoke_json_envelope(environment, core_api.snapshot,
                                "{\"kind\":\"connections\",\"limit\":512}");
  pthread_mutex_unlock(&core_mutex);
  return result;
}

JNIEXPORT jstring JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeCloseTrafficConnection(
    JNIEnv *environment, jobject instance, jstring connection_id,
    jstring event_sequence, jstring session_id) {
  const char *connection = NULL;
  const char *sequence = NULL;
  const char *session = NULL;
  char request[512];
  jstring result;
  (void)instance;
  if (connection_id == NULL || event_sequence == NULL || session_id == NULL)
    return NULL;
  connection = (*environment)->GetStringUTFChars(environment, connection_id, NULL);
  sequence = (*environment)->GetStringUTFChars(environment, event_sequence, NULL);
  session = (*environment)->GetStringUTFChars(environment, session_id, NULL);
  if (!closed_identifier(connection, 128) || !decimal_identifier(sequence, 20) ||
      !closed_identifier(session, 128)) {
    if (connection != NULL)
      (*environment)->ReleaseStringUTFChars(environment, connection_id, connection);
    if (sequence != NULL)
      (*environment)->ReleaseStringUTFChars(environment, event_sequence, sequence);
    if (session != NULL)
      (*environment)->ReleaseStringUTFChars(environment, session_id, session);
    return NULL;
  }
  int written = snprintf(
      request, sizeof(request),
      "{\"connectionId\":\"%s\",\"eventSequence\":\"%s\",\"sessionId\":\"%s\"}",
      connection, sequence, session);
  if (written < 0 || (size_t)written >= sizeof(request)) {
    (*environment)->ReleaseStringUTFChars(environment, connection_id, connection);
    (*environment)->ReleaseStringUTFChars(environment, event_sequence, sequence);
    (*environment)->ReleaseStringUTFChars(environment, session_id, session);
    return NULL;
  }
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  result = invoke_json_envelope(environment, core_api.close_connection, request);
  pthread_mutex_unlock(&core_mutex);
  (*environment)->ReleaseStringUTFChars(environment, connection_id, connection);
  (*environment)->ReleaseStringUTFChars(environment, event_sequence, sequence);
  (*environment)->ReleaseStringUTFChars(environment, session_id, session);
  return result;
}

JNIEXPORT jint JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeAbiVersion(JNIEnv *environment,
                                                                jobject instance) {
  (void)environment;
  (void)instance;
  pthread_once(&core_once, load_core);
  if (core_api.abi_version == NULL) {
    return 0;
  }
  return (jint)core_api.abi_version();
}

JNIEXPORT jstring JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeVersionEnvelope(JNIEnv *environment,
                                                                     jobject instance) {
  (void)instance;
  pthread_once(&core_once, load_core);
  if (core_version == NULL || core_api.free_buffer == NULL) {
    return NULL;
  }

  MishCoreBufferV1 response = {0};
  int32_t status = core_version(&response);
  if (status != MISH_CORE_OK_V1 || response.data == NULL || response.length == 0 ||
      response.length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    core_api.free_buffer(&response);
    return NULL;
  }

  char *text = malloc((size_t)response.length + 1);
  if (text == NULL) {
    core_api.free_buffer(&response);
    return NULL;
  }
  memcpy(text, response.data, (size_t)response.length);
  text[response.length] = '\0';
  core_api.free_buffer(&response);
  jstring result = (*environment)->NewStringUTF(environment, text);
  free(text);
  return result;
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeValidateConfig(
    JNIEnv *environment, jobject instance, jbyteArray config,
    jstring expected_digest) {
  MishVpnCoreValidationResult validation = {
      .code = MISH_VPN_VALIDATION_NATIVE_FAILED,
      .abi_status = -1,
  };
  jbyte *config_bytes = NULL;
  jsize config_length;
  jint encoded[2];
  jintArray result_array;
  const char *digest = NULL;

  (void)instance;
  if (config == NULL || expected_digest == NULL) {
    return NULL;
  }
  digest = (*environment)->GetStringUTFChars(environment, expected_digest, NULL);
  if (digest == NULL) {
    return NULL;
  }
  pthread_once(&core_once, load_core);
  config_length = (*environment)->GetArrayLength(environment, config);
  if ((uint64_t)config_length <= MISH_CORE_MAX_CONFIG_BYTES_V1 &&
      config_length > 0) {
    config_bytes =
        (*environment)->GetByteArrayElements(environment, config, NULL);
    if (config_bytes == NULL) {
      (*environment)->ReleaseStringUTFChars(environment, expected_digest, digest);
      return NULL;
    }
  }

  pthread_mutex_lock(&core_mutex);
  validation = mish_vpn_validate_config(
      &core_api, &core_initialized, (uint8_t *)config_bytes,
      (uint64_t)config_length, digest);
  pthread_mutex_unlock(&core_mutex);

  if (config_bytes != NULL) {
    (*environment)->ReleaseByteArrayElements(environment, config, config_bytes,
                                             JNI_ABORT);
  }
  (*environment)->ReleaseStringUTFChars(environment, expected_digest, digest);
  encoded[0] = validation.code;
  encoded[1] = validation.abi_status;
  result_array = (*environment)->NewIntArray(environment, 2);
  if (result_array == NULL) {
    return NULL;
  }
  (*environment)->SetIntArrayRegion(environment, result_array, 0, 2, encoded);
  return result_array;
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeLoadConfig(
    JNIEnv *environment, jobject instance, jbyteArray config,
    jstring expected_digest) {
  MishVpnCoreLoadResult loaded = {
      .code = MISH_VPN_LOAD_NATIVE_FAILED,
      .abi_status = -1,
      .rollback_guaranteed = 0,
  };
  jbyte *config_bytes = NULL;
  jsize config_length;
  jint encoded[3];
  jintArray result_array;
  const char *digest = NULL;

  (void)instance;
  if (config == NULL || expected_digest == NULL) {
    return NULL;
  }
  digest = (*environment)->GetStringUTFChars(environment, expected_digest, NULL);
  if (digest == NULL) {
    return NULL;
  }
  config_length = (*environment)->GetArrayLength(environment, config);
  if ((uint64_t)config_length <= MISH_CORE_MAX_CONFIG_BYTES_V1 &&
      config_length > 0) {
    config_bytes =
        (*environment)->GetByteArrayElements(environment, config, NULL);
    if (config_bytes == NULL) {
      (*environment)->ReleaseStringUTFChars(environment, expected_digest, digest);
      return NULL;
    }
  }

  pthread_mutex_lock(&core_mutex);
  loaded = mish_vpn_load_config(&core_api, core_initialized,
                                (uint8_t *)config_bytes,
                                (uint64_t)config_length, digest);
  pthread_mutex_unlock(&core_mutex);

  if (config_bytes != NULL) {
    (*environment)->ReleaseByteArrayElements(environment, config, config_bytes,
                                             JNI_ABORT);
  }
  (*environment)->ReleaseStringUTFChars(environment, expected_digest, digest);
  encoded[0] = loaded.code;
  encoded[1] = loaded.abi_status;
  encoded[2] = loaded.rollback_guaranteed;
  result_array = (*environment)->NewIntArray(environment, 3);
  if (result_array == NULL) {
    return NULL;
  }
  (*environment)->SetIntArrayRegion(environment, result_array, 0, 3, encoded);
  return result_array;
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeInspectLoadedConfig(
    JNIEnv *environment, jobject instance, jstring expected_digest) {
  MishVpnCoreInspectionResult inspection;
  const char *digest = NULL;
  jint encoded[2];
  jintArray result_array;

  (void)instance;
  if (expected_digest != NULL) {
    digest =
        (*environment)->GetStringUTFChars(environment, expected_digest, NULL);
    if (digest == NULL) {
      return NULL;
    }
  }
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  inspection = mish_vpn_inspect_loaded_config(&core_api, core_initialized, digest);
  pthread_mutex_unlock(&core_mutex);
  if (digest != NULL) {
    (*environment)->ReleaseStringUTFChars(environment, expected_digest, digest);
  }
  encoded[0] = inspection.code;
  encoded[1] = inspection.abi_status;
  result_array = (*environment)->NewIntArray(environment, 2);
  if (result_array == NULL) {
    return NULL;
  }
  (*environment)->SetIntArrayRegion(environment, result_array, 0, 2, encoded);
  return result_array;
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeStartCore(
    JNIEnv *environment, jobject instance, jstring machine_authority,
    jlong scope_epoch, jstring operation_id, jlong admitted_revision,
    jstring effect_identity, jstring session_id,
    jint tun_file_descriptor, jobject service) {
  MishVpnCoreRuntimeResult result = {
      .code = MISH_VPN_RUNTIME_CORE_UNAVAILABLE,
      .abi_status = -1,
  };
  MishCorePlatformV1 platform = {
      .struct_size = sizeof(MishCorePlatformV1),
      .protect_socket = protect_socket_with_service,
      .user_data = NULL,
  };
  const char *session = NULL;
  const char *machine = NULL;
  const char *operation = NULL;
  const char *effect = NULL;
  MishVpnCoreLifecycleAuthority authority;
  jobject service_reference = NULL;
  (void)instance;
  if (machine_authority == NULL || scope_epoch <= 0 || operation_id == NULL ||
      admitted_revision <= 0 || effect_identity == NULL || session_id == NULL ||
      service == NULL || tun_file_descriptor <= 0) {
    return runtime_array(environment, result);
  }
  machine = (*environment)->GetStringUTFChars(environment, machine_authority, NULL);
  operation = (*environment)->GetStringUTFChars(environment, operation_id, NULL);
  effect = (*environment)->GetStringUTFChars(environment, effect_identity, NULL);
  session = (*environment)->GetStringUTFChars(environment, session_id, NULL);
  service_reference = (*environment)->NewGlobalRef(environment, service);
  if (machine == NULL || operation == NULL || effect == NULL || session == NULL ||
      service_reference == NULL ||
      (*environment)->GetJavaVM(environment, &java_vm) != JNI_OK) {
    if (machine != NULL) (*environment)->ReleaseStringUTFChars(environment, machine_authority, machine);
    if (operation != NULL) (*environment)->ReleaseStringUTFChars(environment, operation_id, operation);
    if (effect != NULL) (*environment)->ReleaseStringUTFChars(environment, effect_identity, effect);
    if (session != NULL) {
      (*environment)->ReleaseStringUTFChars(environment, session_id, session);
    }
    if (service_reference != NULL) {
      (*environment)->DeleteGlobalRef(environment, service_reference);
    }
    return runtime_array(environment, result);
  }
  authority.machine_authority = machine;
  authority.scope_epoch = (uint64_t)scope_epoch;
  authority.operation_id = operation;
  authority.admitted_revision = (uint64_t)admitted_revision;
  authority.effect_identity = effect;
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  pthread_mutex_lock(&protect_mutex);
  jobject previous_service = vpn_service;
  vpn_service = service_reference;
  pthread_mutex_unlock(&protect_mutex);
  result = mish_vpn_start_core(&core_api, &core_initialized, &platform,
                               &authority, session, (int32_t)tun_file_descriptor);
  log_bounded_runtime_failure(result);
  pthread_mutex_lock(&protect_mutex);
  if (result.code == MISH_VPN_RUNTIME_RUNNING) {
    if (previous_service != NULL) {
      (*environment)->DeleteGlobalRef(environment, previous_service);
    }
  } else {
    (*environment)->DeleteGlobalRef(environment, vpn_service);
    vpn_service = previous_service;
  }
  pthread_mutex_unlock(&protect_mutex);
  pthread_mutex_unlock(&core_mutex);
  (*environment)->ReleaseStringUTFChars(environment, machine_authority, machine);
  (*environment)->ReleaseStringUTFChars(environment, operation_id, operation);
  (*environment)->ReleaseStringUTFChars(environment, effect_identity, effect);
  (*environment)->ReleaseStringUTFChars(environment, session_id, session);
  return runtime_array(environment, result);
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeStopCore(
    JNIEnv *environment, jobject instance, jstring machine_authority,
    jlong scope_epoch, jstring operation_id, jlong admitted_revision,
    jstring effect_identity, jstring session_id) {
  MishVpnCoreRuntimeResult result;
  const char *session = NULL;
  const char *machine = NULL;
  const char *operation = NULL;
  const char *effect = NULL;
  MishVpnCoreLifecycleAuthority authority;
  (void)instance;
  if (machine_authority == NULL || scope_epoch <= 0 || operation_id == NULL ||
      admitted_revision <= 0 || effect_identity == NULL) {
    result.code = MISH_VPN_RUNTIME_NATIVE_FAILED;
    result.abi_status = -1;
    return runtime_array(environment, result);
  }
  machine = (*environment)->GetStringUTFChars(environment, machine_authority, NULL);
  operation = (*environment)->GetStringUTFChars(environment, operation_id, NULL);
  effect = (*environment)->GetStringUTFChars(environment, effect_identity, NULL);
  if (session_id != NULL) {
    session = (*environment)->GetStringUTFChars(environment, session_id, NULL);
    if (session == NULL) {
      if (machine != NULL) (*environment)->ReleaseStringUTFChars(environment, machine_authority, machine);
      if (operation != NULL) (*environment)->ReleaseStringUTFChars(environment, operation_id, operation);
      if (effect != NULL) (*environment)->ReleaseStringUTFChars(environment, effect_identity, effect);
      result.code = MISH_VPN_RUNTIME_NATIVE_FAILED;
      result.abi_status = -1;
      return runtime_array(environment, result);
    }
  }
  if (machine == NULL || operation == NULL || effect == NULL) {
    if (machine != NULL) (*environment)->ReleaseStringUTFChars(environment, machine_authority, machine);
    if (operation != NULL) (*environment)->ReleaseStringUTFChars(environment, operation_id, operation);
    if (effect != NULL) (*environment)->ReleaseStringUTFChars(environment, effect_identity, effect);
    if (session != NULL) (*environment)->ReleaseStringUTFChars(environment, session_id, session);
    result.code = MISH_VPN_RUNTIME_NATIVE_FAILED;
    result.abi_status = -1;
    return runtime_array(environment, result);
  }
  authority.machine_authority = machine;
  authority.scope_epoch = (uint64_t)scope_epoch;
  authority.operation_id = operation;
  authority.admitted_revision = (uint64_t)admitted_revision;
  authority.effect_identity = effect;
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  result = mish_vpn_stop_core(&core_api, core_initialized, &authority, session);
  if (result.code == MISH_VPN_RUNTIME_INACTIVE) {
    pthread_mutex_lock(&protect_mutex);
    if (vpn_service != NULL) {
      (*environment)->DeleteGlobalRef(environment, vpn_service);
      vpn_service = NULL;
    }
    pthread_mutex_unlock(&protect_mutex);
  }
  pthread_mutex_unlock(&core_mutex);
  (*environment)->ReleaseStringUTFChars(environment, machine_authority, machine);
  (*environment)->ReleaseStringUTFChars(environment, operation_id, operation);
  (*environment)->ReleaseStringUTFChars(environment, effect_identity, effect);
  if (session != NULL) {
    (*environment)->ReleaseStringUTFChars(environment, session_id, session);
  }
  return runtime_array(environment, result);
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeInspectRuntime(
    JNIEnv *environment, jobject instance, jstring session_id) {
  MishVpnCoreRuntimeResult result;
  const char *session = NULL;
  (void)instance;
  if (session_id != NULL) {
    session = (*environment)->GetStringUTFChars(environment, session_id, NULL);
    if (session == NULL) {
      result.code = MISH_VPN_RUNTIME_NATIVE_FAILED;
      result.abi_status = -1;
      return runtime_array(environment, result);
    }
  }
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  result = mish_vpn_inspect_runtime(&core_api, core_initialized, session);
  pthread_mutex_unlock(&core_mutex);
  if (session != NULL) {
    (*environment)->ReleaseStringUTFChars(environment, session_id, session);
  }
  return runtime_array(environment, result);
}
