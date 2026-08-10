cmake_minimum_required(VERSION 3.18.1)
project(rustrajsi)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_VERBOSE_MAKEFILE ON)

set(CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../ios)

# Prefab imports from React Native Android gradle dependencies
find_package(fbjni REQUIRED NitroConfig)
find_package(ReactAndroid REQUIRED NitroConfig)

# Import compiled Rust static library for current ABI
add_library(rust_calculator_static STATIC IMPORTED)
set_target_properties(rust_calculator_static PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/libs/${ANDROID_ABI}/librustra_calculator_example.a
)

# Define shared library
add_library(rustrajsi SHARED
    src/main/cpp/rustra-jsi-jni.cpp
    ${CPP_DIR}/RustraJSIBridge.cpp
    ${CPP_DIR}/rustra-generated-codecs.cpp
)

target_include_directories(rustrajsi PRIVATE
    ${CPP_DIR}
    src/main/cpp
)

target_link_libraries(rustrajsi
    PRIVATE
    rust_calculator_static
    fbjni::fbjni
    ReactAndroid::jsi
    ReactAndroid::reactnative
    android
    log
)
