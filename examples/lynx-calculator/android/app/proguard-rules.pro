# Lynx Android spike — 디버그 빌드 기준, minify 비활성.
# 릴리스 활성 시 Lynx 리플렉션 기반 NativeModule 바인딩 보호용 룰 추가 필요.
-keep class com.lynx.** { *; }
-keep class com.rustra.lynx.** { *; }
