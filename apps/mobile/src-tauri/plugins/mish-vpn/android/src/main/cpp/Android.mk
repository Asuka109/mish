LOCAL_PATH := $(call my-dir)

include $(CLEAR_VARS)
LOCAL_MODULE := mish_vpn_jni
LOCAL_SRC_FILES := mish_vpn_jni.c
LOCAL_C_INCLUDES := $(MISH_REPOSITORY_ROOT)/mobile-core/abi
LOCAL_CFLAGS := -std=c11 -Wall -Wextra -Werror
LOCAL_LDLIBS := -ldl -llog
include $(BUILD_SHARED_LIBRARY)
