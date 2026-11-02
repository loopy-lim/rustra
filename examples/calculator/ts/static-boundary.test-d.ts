// static-boundary.test-d.ts — 생성 클라이언트의 TS 정적 타입 경계 부정 테스트.
//
// nitro 의 "틀린 구현은 컴파일 실패" 파리티 검증: rustra 는 스키마 → 코드젠으로
// TS 정적 경계를 만들고, 이 파일은 그 경계가 실제로 잘못된 사용을 컴파일 단계에서
// 거부하는지 고정한다. 검증 주체는 `tsc -p examples/calculator/tsconfig.json`
// (test:fast·test:ts:node 에 배선) — 아래 모든 `@ts-expect-error` 는 해당 줄이
// 타입 오류일 때만 유효하고, 경계가 무너져(타입이 느슨해져) 오류가 사라지면
// tsc 가 "Unused '@ts-expect-error' directive" 로 실패한다.
//
// 런타임 러너와는 의도적으로 분리된다 — 파일명이 `*.test.ts` 글롭에 걸리지 않는
// `.test-d.ts` 이며 런타임 문장이 없다. 러너 글롭에 넣지 말 것.
import { add, addNumbers } from '../generated/commands.js';
import type { AddNumbersOutput } from '../generated/types.js';

// 1. positional 함수 인자 타입 오용
// @ts-expect-error positional 인자는 number 여야 한다 — string 은 거부
void add(1, '2');

// 2. struct 명령 필드 타입 오용
// @ts-expect-error b 필드는 number 여야 한다
void addNumbers({ a: 1, b: 'not-a-number' });

// 3. 필수 필드 누락
// @ts-expect-error b 필드가 빠졌다
void addNumbers({ a: 1 });

// 4. 초과 프로퍼티 — 스키마에 없는 필드는 리터럴에서 거부
// @ts-expect-error unknown extra 는 스키마에 없다
void addNumbers({ a: 1, b: 2, extra: true });

// 5. 출력 타입 오용 — value 는 number | bigint 고정
// @ts-expect-error 출력 필드에 string 을 대입할 수 없다
const wrongOutput: AddNumbersOutput = { value: 'not-a-number' };
// @ts-expect-error string 에는 toFixed 가 없다
wrongOutput.value.toFixed;
