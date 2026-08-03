#include <dlfcn.h>
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <stdint.h>
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
  core_api.free_buffer =
      (MishVpnCoreFreeBufferFn)dlsym(core_handle, "mish_core_free_buffer_v1");
  core_version = (MishCoreVersionFn)dlsym(core_handle, "mish_core_version_v1");
  if (core_api.abi_version == NULL || core_api.initialize == NULL ||
      core_api.validate_config == NULL || core_api.free_buffer == NULL ||
      core_api.load_config == NULL || core_api.snapshot == NULL ||
      core_api.start == NULL || core_api.stop == NULL ||
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
    JNIEnv *environment, jobject instance, jstring session_id,
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
  jobject service_reference = NULL;
  (void)instance;
  if (session_id == NULL || service == NULL || tun_file_descriptor <= 0) {
    return runtime_array(environment, result);
  }
  session = (*environment)->GetStringUTFChars(environment, session_id, NULL);
  service_reference = (*environment)->NewGlobalRef(environment, service);
  if (session == NULL || service_reference == NULL ||
      (*environment)->GetJavaVM(environment, &java_vm) != JNI_OK) {
    if (session != NULL) {
      (*environment)->ReleaseStringUTFChars(environment, session_id, session);
    }
    if (service_reference != NULL) {
      (*environment)->DeleteGlobalRef(environment, service_reference);
    }
    return runtime_array(environment, result);
  }
  pthread_once(&core_once, load_core);
  pthread_mutex_lock(&core_mutex);
  pthread_mutex_lock(&protect_mutex);
  jobject previous_service = vpn_service;
  vpn_service = service_reference;
  pthread_mutex_unlock(&protect_mutex);
  result = mish_vpn_start_core(&core_api, &core_initialized, &platform, session,
                               (int32_t)tun_file_descriptor);
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
  (*environment)->ReleaseStringUTFChars(environment, session_id, session);
  return runtime_array(environment, result);
}

JNIEXPORT jintArray JNICALL
Java_com_asuka109_mish_vpn_MishMobileCoreProbe_nativeStopCore(
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
  result = mish_vpn_stop_core(&core_api, core_initialized, session);
  if (result.code == MISH_VPN_RUNTIME_INACTIVE) {
    pthread_mutex_lock(&protect_mutex);
    if (vpn_service != NULL) {
      (*environment)->DeleteGlobalRef(environment, vpn_service);
      vpn_service = NULL;
    }
    pthread_mutex_unlock(&protect_mutex);
  }
  pthread_mutex_unlock(&core_mutex);
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
