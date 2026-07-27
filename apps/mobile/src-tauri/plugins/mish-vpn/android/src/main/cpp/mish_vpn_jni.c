#include <dlfcn.h>
#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "mish_mobile_core.h"
#include "mish_vpn_core_validation.h"

typedef int32_t (*MishCoreVersionFn)(MishCoreBufferV1 *response);

static pthread_once_t core_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t validation_mutex = PTHREAD_MUTEX_INITIALIZER;
static void *core_handle = NULL;
static MishVpnCoreValidationApi core_api = {0};
static MishCoreVersionFn core_version = NULL;
static int core_initialized = 0;

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
  core_api.free_buffer =
      (MishVpnCoreFreeBufferFn)dlsym(core_handle, "mish_core_free_buffer_v1");
  core_version = (MishCoreVersionFn)dlsym(core_handle, "mish_core_version_v1");
  if (core_api.abi_version == NULL || core_api.initialize == NULL ||
      core_api.validate_config == NULL || core_api.free_buffer == NULL ||
      core_version == NULL) {
    memset(&core_api, 0, sizeof(core_api));
    core_version = NULL;
  }
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
    JNIEnv *environment, jobject instance, jbyteArray config) {
  MishVpnCoreValidationResult validation = {
      .code = MISH_VPN_VALIDATION_NATIVE_FAILED,
      .abi_status = -1,
  };
  jbyte *config_bytes = NULL;
  jsize config_length;
  jint encoded[2];
  jintArray result_array;

  (void)instance;
  if (config == NULL) {
    return NULL;
  }
  pthread_once(&core_once, load_core);
  config_length = (*environment)->GetArrayLength(environment, config);
  if ((uint64_t)config_length <= MISH_CORE_MAX_CONFIG_BYTES_V1 &&
      config_length > 0) {
    config_bytes =
        (*environment)->GetByteArrayElements(environment, config, NULL);
    if (config_bytes == NULL) {
      return NULL;
    }
  }

  pthread_mutex_lock(&validation_mutex);
  validation = mish_vpn_validate_config(
      &core_api, &core_initialized, (uint8_t *)config_bytes,
      (uint64_t)config_length);
  pthread_mutex_unlock(&validation_mutex);

  if (config_bytes != NULL) {
    (*environment)->ReleaseByteArrayElements(environment, config, config_bytes,
                                             JNI_ABORT);
  }
  encoded[0] = validation.code;
  encoded[1] = validation.abi_status;
  result_array = (*environment)->NewIntArray(environment, 2);
  if (result_array == NULL) {
    return NULL;
  }
  (*environment)->SetIntArrayRegion(environment, result_array, 0, 2, encoded);
  return result_array;
}
