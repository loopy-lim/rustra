plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.rustra.uniffi.smoke"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.rustra.uniffi.smoke"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "0.0.0"
    }

    packaging {
        jniLibs {
            // JNA 는 소넘(soname) dlopen 으로 로드한다. APK 임베드(non-extracted)
            // 환경의 네임스페이스 해석 차이를 배제하고 네이티브 라이브러리를
            // 반드시 추출해 둔다 — 스모크의 관심사는 바인딩 실행 여부다.
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 생성 바인딩(rustra_calculator_example.kt)이 JNA 기반이다(com.sun.jna 임포트).
    // kotlinx.coroutines 는 사용하지 않는다 — 바인딩 임포트 목록에서 확인됨.
    // Android 에서는 @aar 변형(libjnidispatch 네이티브 포함)이 필요하다.
    implementation("net.java.dev.jna:jna:5.14.0@aar")
}
