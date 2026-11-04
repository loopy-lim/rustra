# 상주 트리 예제 (Resident tree example)

`bun install --frozen-lockfile` 과 `bun run build` 뒤 저장소 루트에서 실행한다:

```bash
bun run test:app:resident-tree
```

이 명령은 Rust 예제를 빌드하고, 스키마에서 TypeScript를 렌더하고, 하나의 상주
Node 전송 위에서 생성된 클라이언트를 실행한다. 손으로 쓴 명령 타입이 필요 없다.
호출 전에 스키마 해시를 검증한다.

`loadTree` 는 트리를 검증해 상주시키고, `findNode` 는 핸들과 대상을 보낸다.
`updateNode` 는 새 세대를 반환하고 이전 핸들을 무효화한다. `releaseTree` 는 트리
하나를 해제하고 `clearTrees` 는 ID를 재사용하지 않고 모든 트리를 해제한다.
프로세스 폐기는 스토어 전체를 내린다. 스토어는 노드 16,384개·깊이 32 상한의
트리 16개를 허용하며, 중복 노드 ID는 거부한다.

`receipt.json` 에 초기 적재 시간, 경로별 100회 개별 측정, 요청 크기가 기록된다.
두 경로는 같은 결과를 돌려주지만, 트리 전체 호출은 검증 비용도 함께 낸다. 이
예제는 디버그 빌드 실측이지 릴리스 성능 주장이 아니다. 관측된 평균 절감
`d = mean(wholeUs) - mean(residentUs)` 에 대해 추정 손익분기 호출 수는 `d > 0`일
때 `ceil(loadMs * 1000 / d)`이고, 아니면 이 실행에는 측정된 손익분기점이 없다.
시작과 계약 핸드셰이크는 `loadMs` 밖이다. 이 패턴을 채택하기 전에 애플리케이션의
저장소·동기화·갱신 빈도를 고려한다.
