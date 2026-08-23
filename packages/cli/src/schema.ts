/**
 * @rustra/cli — rustra CLI 코드 생성 스키마 타입
 *
 * Rust에서 생성된 JSON 스키마를 TypeScript에서 파싱하고
 * 코드 생성에 사용하는 타입 정의입니다.
 */

/**
 * 단일 rustra 명령의 스키마 정의입니다.
 *
 * Rust의 `Package::schema()` 출력에서 각 명령 항목에 해당합니다.
 */
export type CommandSchema = {
  /** 명령 이름 (예: "addNumbers") */
  name: string;
  /** 명령 ID (rkyv V2 바이너리 프로토콜용, 1부터 시작) */
  commandId: number;
  /** 입력 타입의 짧은 이름 (예: "AddNumbersInput") */
  inputType: string;
  /** 출력 타입의 짧은 이름 (예: "AddNumbersOutput") */
  outputType: string;
  /** 입력 타입의 JSON Schema */
  inputSchema: JsonSchema;
  /** 출력 타입의 JSON Schema */
  outputSchema: JsonSchema;
  /** 명명된 타입 정의 (schemars가 생성한 $ref 대상) */
  definitions?: Record<string, JsonSchema>;
};

/**
 * 전체 패키지 스키마입니다.
 *
 * Rust의 `Package::schema()` 출력에 해당하며,
 * CLI가 `schema.json` 파일로 읽어들입니다.
 */
export type PackageSchema = {
  /** 패키지 식별자 (예: "example.calculator") */
  packageId: string;
  /**
   * (T2, OTA) 스키마 협상 버전. `contract.ts` 의 `SCHEMA_VERSION` 으로
   * 노출되며, JS 클라이언트가 네이티브 live schema 의 버전과 비교해
   * JS > native stale 조합을 감지하는 데 쓰인다. 구 스키마에는 없어도
   * 된다 — 그 경우 코드젠은 1 로 취급한다.
   */
  schemaVersion?: number;
  /**
   * Binary object fields follow the Rust declaration order. Current rustra
   * schema emitters always include this marker; it is optional for legacy
   * and third-party schema files.
   */
  fieldOrder?: 'declaration';
  /** 패키지에 등록된 모든 명령 스키마 */
  commands: CommandSchema[];
  /**
   * (이벤트 계약) Rust `PackageBuilder::event::<E>("name")` 으로 선언된
   * 이벤트 — 이름/페이로드 스키마. `events.ts`(타입 + 구독 헬퍼) 생성에
   * 쓰인다. 선언이 없으면 섹션 자체가 없다(하위호환).
   */
  events?: EventSchema[];
};

/**
 * 선언된 이벤트 계약 — Rust `PackageBuilder::event` 의 schema.json 표현.
 */
export type EventSchema = {
  /** 이벤트 이름 (예: "progress.tick") */
  name: string;
  /** 페이로드 타입의 JSON Schema */
  payload: JsonSchema;
  /** 페이로드 타입의 명명된 정의 ($ref 대상) */
  definitions?: Record<string, JsonSchema>;
};

/**
 * JSON Schema의 TypeScript 표현입니다.
 *
 * rustra가 지원하는 JSON Schema 서브셋을 나타내며,
 * TypeScript 타입 생성에 사용됩니다.
 */
export type JsonSchema = {
  /** 스키마 타입 ("string", "number", "boolean", "object", "array", "null" 또는 유니온 배열) */
  type?: string | string[];
  /** object 타입의 속성 정의 */
  properties?: Record<string, JsonSchema>;
  /** 필수 속성 이름 목록 */
  required?: string[];
  /** array 타입의 요소 스키마 */
  items?: JsonSchema | JsonSchema[];
  /** 튜플 각 위치의 요소 스키마 (JSON Schema 2020-12 튜플 표현) */
  prefixItems?: JsonSchema[];
  /** 배열 요소의 유일성 (Rust `BTreeSet`/`HashSet` → TS `Set<T>`) */
  uniqueItems?: boolean;
  additionalProperties?: JsonSchema;
  /** 다른 스키마에 대한 참조 (예: "#/definitions/Foo") */
  $ref?: string;
  /** 유니온 타입의 각 변형 */
  anyOf?: JsonSchema[];
  /** 유니온 타입의 각 변형 (JSON Schema oneOf — 판별 유니온에 사용) */
  oneOf?: JsonSchema[];
  /** 교차 타입의 각 구성 (JSON Schema allOf → TS `A & B`) */
  allOf?: JsonSchema[];
  /** 프로퍼티의 상수 값 (판별 유니온의 태그 필드 등) */
  const?: unknown;
  /** enum 값 목록 — string 또는 integer 리터럴 */
  enum?: (string | number)[];
  /** 스키마 제목 */
  title?: string;
  /** 값 형식 (예: "int64", "date-time") */
  format?: string;
  /** 명명된 타입 정의 맵 */
  definitions?: Record<string, JsonSchema>;
  /** 기타 JSON Schema 속성 */
  [key: string]: unknown;
};
