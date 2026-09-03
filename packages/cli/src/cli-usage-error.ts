/**
 * Usage 에러 — 공유 인자 파서(cli-arg-parser.ts)가 던지는 "호출을 잘못한" 오류.
 *
 * exit-2 경계 계약: 플래그/인자 형태 오류(알 수 없는 플래그, 값 누락, 닫힌
 * 열거 외 값, 위치인자 수) = exit 2(UsageError). 프로젝트/환경 상태 오류(파일
 * 부재, 설정 파싱 실패, 빌드 실패) = exit 1.
 *
 * index.ts 의 메인 핸들러는 `instanceof UsageError` 로 판별해 exit 2 (usage)와
 * exit 1 (런타임 실패)을 구분한다. CI가 "CLI를 잘못 실행했다"와 "코드젠이
 * 실제로 실패했다"를 자동으로 갈라내는 계약 표면이다.
 */
export class UsageError extends Error {}
