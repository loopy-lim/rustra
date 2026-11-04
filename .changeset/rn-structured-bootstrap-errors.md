---
'@rustra/react-native': minor
---

부트스트랩(install·네이티브 엔진 구성) 실패를 `bootstrap.failed` 코드로 발급하고
`cause`에 근본 오류를 보존한다. JSI 네이티브 모듈 미설치(Expo Go, 네이티브 재빌드
누락)는 `native.not_installed`로 분류해 invoke 계열과 동일한 `error.code` 분기를
제공한다. JS reload는 네이티브 drift를 복구하지 않는다.
