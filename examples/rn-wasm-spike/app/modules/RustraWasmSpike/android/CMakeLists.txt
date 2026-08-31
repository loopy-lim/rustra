cmake_minimum_required(VERSION 3.18.1)
project(rustra_wasm_spike)

set(CMAKE_CXX_STANDARD 17)

# vendored wasm3 core sources (same files the iOS target compiles)
# Locate native/wasm3 by walking up from this module dir (works both from
# the source tree and bun's node_modules copy, which differ in depth).
set(WASM3_DIR "" CACHE PATH "")
if(NOT WASM3_DIR)
  set(_probe "${CMAKE_CURRENT_SOURCE_DIR}")
  while(NOT EXISTS "${_probe}/native/wasm3/m3_core.c" AND NOT "${_probe}" STREQUAL "/")
    get_filename_component(_probe "${_probe}" DIRECTORY)
  endwhile()
  if(EXISTS "${_probe}/native/wasm3/m3_core.c")
    set(WASM3_DIR "${_probe}/native/wasm3")
  else()
    message(FATAL_ERROR "CMakeLists: cannot locate native/wasm3 above ${CMAKE_CURRENT_SOURCE_DIR}")
  endif()
endif()

# per-ABI prebuilt staticlib from scripts/build-android.sh
set(RUST_STATIC_DIR "${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/libs/${ANDROID_ABI}")
set(RUST_STATIC_LIB "${RUST_STATIC_DIR}/librustra_wasm_spike_backend.a")

add_library(wasm3 STATIC
  ${WASM3_DIR}/m3_core.c
  ${WASM3_DIR}/m3_bind.c
  ${WASM3_DIR}/m3_code.c
  ${WASM3_DIR}/m3_compile.c
  ${WASM3_DIR}/m3_exec.c
  ${WASM3_DIR}/m3_env.c
  ${WASM3_DIR}/m3_function.c
  ${WASM3_DIR}/m3_info.c
  ${WASM3_DIR}/m3_module.c
  ${WASM3_DIR}/m3_parse.c
  ${WASM3_DIR}/m3_validate.c
)
target_include_directories(wasm3 PUBLIC ${WASM3_DIR})
target_compile_options(wasm3 PRIVATE -O2 -fno-strict-aliasing)

add_library(rustra_wasm_spike SHARED Wasm3Jni.cpp)
target_include_directories(rustra_wasm_spike PRIVATE ${WASM3_DIR})
target_link_libraries(rustra_wasm_spike PRIVATE wasm3 ${RUST_STATIC_LIB} log android)
