// UniFFI Kotlin 바인딩 런타임 스모크용 최소 단일 모듈 Gradle 앱.
// 에뮬레이터에서 생성 바인딩(.kt) + Rust .so 가 실제 로드·실행되는지 마커로 증명한다.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "uniffi-android-smoke"
include(":app")
