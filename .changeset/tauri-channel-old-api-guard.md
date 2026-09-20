---
'@rustra/tauri': patch
---

구버전(@tauri-apps/api 2.4 이하) Tauri 런타임에서 Channel 생성자가 onMessage 콜백 인자를 무시해 채널 메시지가 끝까지 도달하지 않던 무음 실패를 고쳤습니다. 이제 생성자 arity(`Channel.length === 0`)로 구버전을 감지하면 조용히 진행하지 않고, @tauri-apps/api 2.5+ 가 필요하다는 안내와 함께 업그레이드 명령(`bun add @tauri-apps/api@^2.5.0` 또는 `npm install @tauri-apps/api@^2.5.0`)을 담은 오류를 던집니다. 콜백 없이 Channel 을 다루는 기존 경로와 2.5+ 환경의 성공 경로는 이전과 동일하게 동작합니다.
