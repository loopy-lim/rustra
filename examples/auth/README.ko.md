# Auth 예시 — 세션/토큰 + capability 게이트

세션 토큰 발급·폐기와 Runtime Authority(capability) 기반 접근 제어를 보여주는
예시. deny-by-default — capability를 명시적으로 부여받기 전까지 보호된
커맨드는 핸들러조차 실행되지 않는다.

## 구조

```
auth/
├── src/lib.rs            signIn/signOut/grant/adminStats (+ capability 게이트)
├── src/bin/invoke.rs     stdio 라인 데몬(--serve) — 구조화된 에러 JSON 응답
├── apps/node-app.ts      Node end-to-end 데모 (3단계 시나리오)
├── tests/auth_flow.rs    통합 테스트 (전체 capability 플로우)
└── ts/auth.test.ts       유닛 테스트 (mock 엔진 + 에러 code 보존)
```

## 실행 (end-to-end)

```bash
cargo build -p rustra-auth-example
bunx tsc -p examples/auth/tsconfig.json
node dist-ts/examples/auth/apps/node-app.js
```

출력:

```
[auth] user grant admin.stats → denied (role=user)
[auth] adminStats: sessions=2 uptime=0ms
[auth] after signOut: capability.denied (as expected)
[auth] PASS — capability gate verified (user denied / admin allowed / revoked)
```

## 시나리오

1. 일반 사용자(`password123`)는 `grant`가 거부된다 — role 정책
2. admin(`hunter2`)은 `admin.stats` capability를 부여받고 `adminStats` 성공
3. `signOut` 후 재호출 → `capability.denied` (에러 code가 와이어를 통해 보존됨)

## 데모 정책 (실서비스 대체점)

- 비밀번호 검증: `"hunter2"` → admin (실제로는 백엔드 조회/페더레이션)
- 토큰: `role-<sha256-8bytes>` (실제로는 JWT/opaque token + 만료)
- 세션 저장: 프로세스 내 `BTreeMap` (실제로는 Redis/DB)

capability 게이트 패턴 자체(`RustraError::capability_denied`)는 그대로
프로덕션 적용이 가능하다 — `crates/rustra`의 Runtime Authority 참조.
