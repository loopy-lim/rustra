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
  /** 패키지에 등록된 모든 명령 스키마 */
  commands: CommandSchema[];
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
  additionalProperties?: JsonSchema;
  /** 다른 스키마에 대한 참조 (예: "#/definitions/Foo") */
  $ref?: string;
  /** 유니온 타입의 각 변형 */
  anyOf?: JsonSchema[];
  /** 문자열 enum 값 목록 */
  enum?: string[];
  /** 스키마 제목 */
  title?: string;
  /** 값 형식 (예: "int64", "date-time") */
  format?: string;
  /** 명명된 타입 정의 맵 */
  definitions?: Record<string, JsonSchema>;
  /** 기타 JSON Schema 속성 */
  [key: string]: unknown;
};
