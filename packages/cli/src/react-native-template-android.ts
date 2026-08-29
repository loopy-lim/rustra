export function renderGradle(options: {
  adapterFromAndroid: string;
  generatedFromAndroid: string;
  manifestFromModule: string;
  rustLibrary: string;
  cmakeLegacy: string;
}): string {
  return `import javax.inject.Inject
import org.gradle.process.ExecOperations

buildscript {
  repositories { google(); mavenCentral() }
  dependencies {
    classpath "com.android.tools.build:gradle:8.7.2"
    classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20"
  }
}

apply plugin: "com.android.library"
apply plugin: "kotlin-android"

def extOr = { name, fallback -> rootProject.ext.has(name) ? rootProject.ext.get(name) : fallback }
def adapterRoot = file(${JSON.stringify(options.adapterFromAndroid)}).canonicalFile
def generatedRoot = file(${JSON.stringify(options.generatedFromAndroid)}).canonicalFile
def rustManifest = file(${JSON.stringify(`../${options.manifestFromModule}`)}).canonicalFile
def rustLibsDir = file("src/main/cpp/libs")

abstract class RustraExecOperations {
  @Inject abstract ExecOperations getExecOperations()
}
def rustraExec = objects.newInstance(RustraExecOperations)

android {
  namespace = "dev.rustra.bridge"
  compileSdk = extOr("compileSdkVersion", 36)
  ndkVersion = extOr("ndkVersion", "27.1.12297006")
  defaultConfig {
    minSdk = extOr("minSdkVersion", 24)
    targetSdk = extOr("targetSdkVersion", 36)
    externalNativeBuild.cmake {
      cppFlags "-std=c++20"
      arguments "-DANDROID_STL=c++_shared", "-DRUSTRA_ADAPTER_ROOT=$adapterRoot", "-DRUSTRA_GENERATED_ROOT=$generatedRoot", "-DRUSTRA_LIB_NAME=${options.rustLibrary}", "-DRUSTRA_LEGACY_BENCHMARKS=${options.cmakeLegacy}"
    }
    ndk { abiFilters "x86_64", "arm64-v8a" }
  }
  externalNativeBuild.cmake.path = file("CMakeLists.txt")
  buildFeatures.prefab = true
  packagingOptions.excludes = ["**/libc++_shared.so"]
  sourceSets.main.java.srcDirs = ["src/main/java"]
}

tasks.register("buildRustAndroid") {
  inputs.files(fileTree(rustManifest.parentFile) { include "**/*.rs", "**/Cargo.toml", "Cargo.lock"; exclude "target/**", "**/node_modules/**", "**/build/**" })
  inputs.property("profile", gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") } ? "release" : "debug")
  outputs.dir(rustLibsDir)
  outputs.cacheIf { true }
  doLast {
    def release = gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") }
    rustraExec.execOperations.exec { workingDir projectDir; environment "RUSTRA_PROFILE", release ? "release" : "debug"; commandLine "sh", "build-rust-android.sh" }
  }
}
preBuild.dependsOn "buildRustAndroid"
repositories { google(); mavenCentral() }
dependencies { implementation "com.facebook.react:react-android" }
`;
}

export function renderCmake(): string {
  return `cmake_minimum_required(VERSION 3.18.1)
project(rustra_bridge)
set(CMAKE_CXX_STANDARD 20)
find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)
add_library(rustra_static STATIC IMPORTED)
set_target_properties(rustra_static PROPERTIES IMPORTED_LOCATION \${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp/libs/\${ANDROID_ABI}/lib\${RUSTRA_LIB_NAME}.a)
add_library(rustra_bridge SHARED \${RUSTRA_ADAPTER_ROOT}/android/rustra-jsi-jni.cpp \${RUSTRA_ADAPTER_ROOT}/cpp/RustraJSIBridge.cpp \${RUSTRA_GENERATED_ROOT}/rustra-generated-codecs.cpp)
target_include_directories(rustra_bridge PRIVATE \${RUSTRA_ADAPTER_ROOT}/cpp \${RUSTRA_GENERATED_ROOT})
if(RUSTRA_LEGACY_BENCHMARKS)
  target_compile_definitions(rustra_bridge PRIVATE RUSTRA_ENABLE_LEGACY_BENCHMARKS=1)
endif()
target_link_libraries(rustra_bridge PRIVATE rustra_static fbjni::fbjni ReactAndroid::jsi ReactAndroid::reactnative android log)
`;
}

export function renderAndroidModule(): string {
  return `package dev.rustra.bridge

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

class RustraBridgeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object { init { System.loadLibrary("rustra_bridge") } }
  override fun getName(): String = "RustraBridge"
  override fun invalidate() { nativeInvalidate(); super.invalidate() }
  @ReactMethod
  fun install(promise: Promise) {
    val pointer = reactApplicationContext.javaScriptContextHolder?.get()
    if (pointer == null || pointer == 0L) { promise.reject("ERR_NO_RUNTIME", "JavaScript context pointer is null"); return }
    if (nativeInstall(pointer, reactApplicationContext.jsCallInvokerHolder)) promise.resolve(true)
    else promise.reject("ERR_INSTALL", "Failed to install Rustra onto the JSI runtime")
  }
  private external fun nativeInstall(pointer: Long, holder: CallInvokerHolder?): Boolean
  private external fun nativeInvalidate()
}
`;
}

export function renderAndroidPackage(): string {
  return `package dev.rustra.bridge

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class RustraBridgePackage : ReactPackage {
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(RustraBridgeModule(reactContext))
  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
`;
}
