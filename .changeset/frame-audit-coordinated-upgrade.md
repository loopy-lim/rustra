---
'@rustra/types': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/cli': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
'@rustra/react': minor
'@rustra/testing': minor
'@rustra/devtools': minor
---

Frame 공개 심볼·생성물 이름 전환과 감사 수정의 동시 업그레이드를 준비합니다.
Rust 라이브러리와 JS 어댑터, 생성 네이티브 셸을 함께 갱신해야 합니다. 이미 발행된
0.9.0을 재사용하지 않습니다. Rust workspace 버전과 CLI cargoRange는 별도 릴리스
단계에서 함께 조정해야 하며, 이 changeset은 Rust 버전을 변경하지 않습니다.

Tauri JS 채널을 발급 WebView의 IPC Channel에 귀속하고 이전 브로드캐스트 호스트를
거부합니다. React 캐시를 엔진 범위로 격리하고 용량·TTL·대기 한도를 적용합니다.
Node/Bun bootstrap 종료와 소유권, CLI 감시·UniFFI 바인딩 신선도, API·문서·퍼징
검사를 보강합니다. 상세 절차: docs/migrations/post-0.9-frame-and-audit.ko.md.
