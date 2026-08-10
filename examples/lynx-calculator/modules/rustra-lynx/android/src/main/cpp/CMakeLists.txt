cmake_minimum_required(VERSION 3.22)
project(rustra_lynx)

# Rust staticlib — ABI별 빌드 산출물을 링크.
# build-rust-android.sh 가 rust/lib/librustra_calculator_example-<ABI>.a 로 배치.
set(RUST_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../rust/lib/librustra_calculator_example-${ANDROID_ABI}.a")

add_library(rustra_lynx SHARED rustra_jni.cpp)

add_library(rustracalc STATIC IMPORTED)
set_target_properties(rustracalc PROPERTIES IMPORTED_LOCATION "${RUST_LIB}")

find_library(log-lib log)

target_link_libraries(rustra_lynx
  rustracalc
  ${log-lib}
)
