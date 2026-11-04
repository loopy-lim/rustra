---
'@rustra/types': minor
---

RN 어댑터의 부트스트랩 실패와 네이티브 미설치를 분류하는
`RustraErrorCode.BootstrapFailed`(`bootstrap.failed`)와
`RustraErrorCode.NativeNotInstalled`(`native.not_installed`)를 추가한다. 두 코드는
JS 어댑터 측 전용으로 Rust error.rs에는 대응 값이 없다.
