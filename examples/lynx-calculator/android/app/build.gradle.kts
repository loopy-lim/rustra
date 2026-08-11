plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.rustra.lynxapp"
    compileSdk = 35
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "com.rustra.lynxapp"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // 스파이크 에뮬레이터(Apple Silicon → arm64) 단일 ABI.
        ndk {
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_static")
            }
        }
    }

    // rustra-lynx 모듈의 JNI/CMake 를 호스트 앱 빌드에 편입.
    // app 모듈 디렉토리(examples/lynx-calculator/android/app) 기준 상대경로:
    //   ../../modules/rustra-lynx/android/...
    externalNativeBuild {
        cmake {
            path = file("../../modules/rustra-lynx/android/src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // rustra-lynx 모듈의 Kotlin 소스(RustraModule)를 호스트 앱 srcSet 으로 편입 —
    // 한 벌의 소스를 iOS/Android/데스크톱이 공유(DRY).
    sourceSets {
        getByName("main") {
            java.srcDirs("../../modules/rustra-lynx/android/src/main/java")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

dependencies {
    // Lynx Android SDK 4.0.1 — Maven Central(org.lynxsdk.lynx) 에서 해석.
    // iOS 4.0.x 라인과 정렬. 핵심 엔진 + JS runtime + 서비스 최소셋.
    implementation("org.lynxsdk.lynx:lynx:4.0.1")
    implementation("org.lynxsdk.lynx:lynx-jssdk:4.0.1")
    implementation("org.lynxsdk.lynx:lynx-trace:4.0.1")
    implementation("org.lynxsdk.lynx:lynx-service-log:4.0.1")
    implementation("org.lynxsdk.lynx:lynx-service-http:4.0.1")

    // Lynx SDK 가 androidx.core.util.Consumer(LynxUIOwner) 를 사용 — aar 가
    // 전이 의존성으로 선언하지 않으므로 명시적으로 추가.
    implementation("androidx.core:core:1.13.1")
}
