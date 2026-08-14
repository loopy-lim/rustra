cmake_minimum_required(VERSION 3.22)
project(rustra_lynx)

# rustra runner 템플릿 — Rust staticlib 를 JNI .so 에 링크.
# 스파이크 examples/lynx-calculator/modules/rustra-lynx/android/src/main/cpp/CMakeLists.txt
# 에서 정제 추출 — lib 이름만 librustra_template_backend-<triple>.a.
#
# build-rust-android.sh 가 rust/lib/librustra_template_backend-<Rust triple>.a 로 배치.
# 이 CMakeLists 는 modules/rustra-lynx/android/src/main/cpp 에 있으므로
# .a 위치(modules/rustra-lynx/rust/lib)까지 ../../../../rust/lib 로 거슬러 간다
# (cpp→main→src→android→rustra-lynx).
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

set(RUST_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../../../../rust/lib/librustra_template_backend-${RUST_TRIPLE}.a")

add_library(rustra_lynx SHARED rustra_jni.cpp)

add_library(rustrabackend STATIC IMPORTED)
set_target_properties(rustrabackend PROPERTIES IMPORTED_LOCATION "${RUST_LIB}")

find_library(log-lib log)

target_link_libraries(rustra_lynx
  rustrabackend
  ${log-lib}
)
