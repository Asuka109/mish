package main

/*
#include "../abi/mish_mobile_core.h"
#include <stdlib.h>
#include <string.h>

static void *mish_core_platform_protect_callback_v1(const MishCorePlatformV1 *platform) {
  return (void *)platform->protect_socket;
}

static void *mish_core_platform_user_data_v1(const MishCorePlatformV1 *platform) {
  return platform->user_data;
}

static int32_t mish_core_call_protect_socket_v1(void *callback, int32_t socket_fd,
                                                void *user_data) {
  return ((MishCoreProtectSocketFnV1)callback)(socket_fd, user_data);
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

const (
	maxConfigBytes   = uint64(C.MISH_CORE_MAX_CONFIG_BYTES_V1)
	maxRequestBytes  = uint64(C.MISH_CORE_MAX_REQUEST_BYTES_V1)
	maxResponseBytes = int(C.MISH_CORE_MAX_RESPONSE_BYTES_V1)
)

func main() {}

func readInput(data *C.uint8_t, length C.uint64_t, maximum uint64) ([]byte, coreStatus) {
	if uint64(length) > maximum {
		return nil, statusLimitExceeded
	}
	if length == 0 {
		return []byte{}, statusOK
	}
	if data == nil {
		return nil, statusInvalidArgument
	}
	return C.GoBytes(unsafe.Pointer(data), C.int(length)), statusOK
}

func writeResponse(response *C.MishCoreBufferV1, result coreResult) C.int32_t {
	if response == nil {
		return C.int32_t(statusInvalidArgument)
	}
	response.data = nil
	response.length = 0
	if len(result.payload) > maxResponseBytes {
		result = failureResult(statusLimitExceeded, "response exceeds the ABI limit")
	}
	if len(result.payload) == 0 {
		return C.int32_t(result.status)
	}
	pointer := C.malloc(C.size_t(len(result.payload)))
	if pointer == nil {
		return C.int32_t(statusFailure)
	}
	C.memcpy(pointer, unsafe.Pointer(&result.payload[0]), C.size_t(len(result.payload)))
	response.data = (*C.uint8_t)(pointer)
	response.length = C.uint64_t(len(result.payload))
	return C.int32_t(result.status)
}

func invokeWithInput(
	data *C.uint8_t,
	length C.uint64_t,
	maximum uint64,
	response *C.MishCoreBufferV1,
	operation func([]byte) coreResult,
) (status C.int32_t) {
	defer func() {
		if recovered := recover(); recovered != nil {
			status = writeResponse(response, failureResult(statusFailure, "core operation panicked"))
		}
	}()
	input, inputStatus := readInput(data, length, maximum)
	if inputStatus != statusOK {
		return writeResponse(response, failureResult(inputStatus, inputStatus.message()))
	}
	return writeResponse(response, operation(input))
}

//export mish_core_abi_version_v1
func mish_core_abi_version_v1() C.uint32_t {
	return C.uint32_t(C.MISH_CORE_ABI_VERSION_V1)
}

//export mish_core_initialize_v1
func mish_core_initialize_v1(
	platform *C.MishCorePlatformV1,
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	if platform == nil || platform.struct_size < C.uint32_t(C.sizeof_MishCorePlatformV1) {
		return writeResponse(response, failureResult(statusInvalidArgument, "platform callback table is incomplete"))
	}
	callback := C.mish_core_platform_protect_callback_v1(platform)
	if callback == nil {
		return writeResponse(response, failureResult(statusInvalidArgument, "socket protection callback is required"))
	}
	userData := C.mish_core_platform_user_data_v1(platform)
	protect := func(socketFD int) error {
		if C.mish_core_call_protect_socket_v1(callback, C.int32_t(socketFD), userData) != 0 {
			return fmt.Errorf("platform rejected socket protection")
		}
		return nil
	}
	return invokeWithInput(request, requestLength, maxRequestBytes, response, func(input []byte) coreResult {
		return mobileCore.initialize(input, protect)
	})
}

//export mish_core_version_v1
func mish_core_version_v1(response *C.MishCoreBufferV1) C.int32_t {
	return writeResponse(response, mobileCore.version())
}

//export mish_core_validate_config_v1
func mish_core_validate_config_v1(
	config *C.uint8_t,
	configLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(config, configLength, maxConfigBytes, response, mobileCore.validateConfig)
}

//export mish_core_load_config_v1
func mish_core_load_config_v1(
	config *C.uint8_t,
	configLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(config, configLength, maxConfigBytes, response, mobileCore.loadConfig)
}

//export mish_core_start_v1
func mish_core_start_v1(
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(request, requestLength, maxRequestBytes, response, mobileCore.start)
}

//export mish_core_stop_v1
func mish_core_stop_v1(
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(request, requestLength, maxRequestBytes, response, mobileCore.stop)
}

//export mish_core_snapshot_v1
func mish_core_snapshot_v1(
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(request, requestLength, maxRequestBytes, response, mobileCore.snapshot)
}

//export mish_core_command_v1
func mish_core_command_v1(
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(request, requestLength, maxRequestBytes, response, mobileCore.command)
}

//export mish_core_poll_events_v1
func mish_core_poll_events_v1(
	request *C.uint8_t,
	requestLength C.uint64_t,
	response *C.MishCoreBufferV1,
) C.int32_t {
	return invokeWithInput(request, requestLength, maxRequestBytes, response, mobileCore.pollEvents)
}

//export mish_core_free_buffer_v1
func mish_core_free_buffer_v1(buffer *C.MishCoreBufferV1) {
	if buffer == nil {
		return
	}
	if buffer.data != nil {
		C.free(unsafe.Pointer(buffer.data))
	}
	buffer.data = nil
	buffer.length = 0
}
