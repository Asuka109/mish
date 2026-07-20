#include <dlfcn.h>
#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "mish_mobile_core.h"

typedef uint32_t (*MishCoreAbiVersionFn)(void);
typedef int32_t (*MishCoreVersionFn)(MishCoreBufferV1 *response);
typedef void (*MishCoreFreeBufferFn)(MishCoreBufferV1 *buffer);

static pthread_once_t core_once = PTHREAD_ONCE_INIT;
static void *core_handle = NULL;
static MishCoreAbiVersionFn core_abi_version = NULL;
static MishCoreVersionFn core_version = NULL;
static MishCoreFreeBufferFn core_free_buffer = NULL;

static void load_core(void) {
  core_handle = dlopen("libmish_mobile_core.so", RTLD_NOW | RTLD_LOCAL);
  if (core_handle == NULL) {
    return;
  }
  core_abi_version = (MishCoreAbiVersionFn)dlsym(core_handle, "mish_core_abi_version_v1");
  core_version = (MishCoreVersionFn)dlsym(core_handle, "mish_core_version_v1");
  core_free_buffer =
      (MishCoreFreeBufferFn)dlsym(core_handle, "mish_core_free_buffer_v1");
  if (core_abi_version == NULL || core_version == NULL || core_free_buffer == NULL) {
    core_abi_version = NULL;
    core_version = NULL;
    core_free_buffer = NULL;
  }
}

JNIEXPORT jint JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeAbiVersion(JNIEnv *environment,
                                                                jobject instance) {
  (void)environment;
  (void)instance;
  pthread_once(&core_once, load_core);
  if (core_abi_version == NULL) {
    return 0;
  }
  return (jint)core_abi_version();
}

JNIEXPORT jstring JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeVersionEnvelope(JNIEnv *environment,
                                                                     jobject instance) {
  (void)instance;
  pthread_once(&core_once, load_core);
  if (core_version == NULL || core_free_buffer == NULL) {
    return NULL;
  }

  MishCoreBufferV1 response = {0};
  int32_t status = core_version(&response);
  if (status != MISH_CORE_OK_V1 || response.data == NULL || response.length == 0 ||
      response.length > MISH_CORE_MAX_RESPONSE_BYTES_V1) {
    core_free_buffer(&response);
    return NULL;
  }

  char *text = malloc((size_t)response.length + 1);
  if (text == NULL) {
    core_free_buffer(&response);
    return NULL;
  }
  memcpy(text, response.data, (size_t)response.length);
  text[response.length] = '\0';
  core_free_buffer(&response);
  jstring result = (*environment)->NewStringUTF(environment, text);
  free(text);
  return result;
}
