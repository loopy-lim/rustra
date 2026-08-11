cmake_minimum_required(VERSION 3.22)
project(rustra_lynx)

# Rust staticlib — ABI별 빌드 산출물을 링크.
# build-rust-android.sh 가 rust/lib/librustra_calculator_example-<Rust triple>.a 로 배치.
# 이 CMakeLists 는 modules/rustra-lynx/android/src/main/cpp 에 있으므로
# .a 위치(android/rust/lib)까지 ../../../rust/lib 로 거슬러 간다
# (cpp→main→src→android).
#
# ANDROID_ABI(android) → Rust target triple 매핑 (cargo-ndk 출력 디렉토리명).
if(ANDROID_ABI STREQUAL "arm64-v8a")
  set(RUST_TRIPLE "aarch64-linux-android")
elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
  set(RUST_TRIPLE "armv7-linux-androideabi")
elseif(ANDROID_ABI STREQUAL "x86")
  set(RUST_TRIPLE "i686-linux-android")
elseif(ANDROID_ABI STREQUAL "x86_64")
  set(RUST_TRIPLE "x86_64-linux-android")
else()
  message(FATAL_ERROR "unsupported ANDROID_ABI: ${ANDROID_ABI}")
endif()

set(RUST_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../../../rust/lib/librustra_calculator_example-${RUST_TRIPLE}.a")

add_library(rustra_lynx SHARED rustra_jni.cpp)

add_library(rustracalc STATIC IMPORTED)
set_target_properties(rustracalc PROPERTIES IMPORTED_LOCATION "${RUST_LIB}")

find_library(log-lib log)

target_link_libraries(rustra_lynx
  rustracalc
  ${log-lib}
)
