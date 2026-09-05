/**
 * 모든 코드젠 산출물에 각인되는 자기서술 헤더.
 *
 * 듀얼 패스 시대의 유산 — "이 파일을 뭐가 만들었지? 뭘 돌려야 최신이지?" — 를
 * 파일 자체가 대답한다. 바이트 안정적이어야 한다(스냅샷·매니페스트 게이트 정합).
 *
 * 헤더 문법은 파일 종류별로 판정한다(CI01 근원 — CI runs 33720307160,
 * 33776685582). 무조건 `//`을 찍던 이전 동작은 JSON(RFC 8259상 주석 불가),
 * Ruby podspec, XML, shebang 스크립트를 파괴했다. 판정 근거는 실측으로 확정했다:
 * - JSON: 주석 문법이 없다. 출처 추적은 .rustra-generated.json 매니페스트가
 *   단일 진실원으로 담당한다 — 파일 내 헤더를 넣지 않는다.
 * - CMake: `cmake -P`가 `//` 라인을 "Parse error. Expected a command name"으로
 *   죽인다. CMake의 줄 주석은 `#` 하나다.
 * - XML: 주석 본문에 `--`를 쓸 수 없다(xmllint "Double hyphen within comment").
 *   헤더 본문의 `--config` 플래그를 `[config: rustra.json]`으로 다시 표현한다.
 * - shebang: 커널 exec 파서가 첫 두 바이트만 보므로 헤더는 반드시 그 뒤에 붙는다.
 */
export function generatedFileHeader(fileName: string, stage: string, content?: string): string {
  const syntax = syntaxFor(fileName);
  if (syntax === 'none') return content ?? '';
  if (syntax === 'hash' && content?.startsWith('#!')) {
    const [firstLine, rest] = splitFirstLine(content);
    return `${firstLine}\n${headerLines(fileName, '#', stage)}${rest}`;
  }
  return `${headerLines(fileName, commentToken(syntax), stage)}${content ?? ''}`;
}

/**
 * 헤더가 붙은 생성물에서 헤더를 벗겨 원문을 회복하는 역방향 헬퍼.
 * generatedFileHeader 와 대칭임을 테스트로 증명한다 —
 * headerFor(generatedFileHeader(f, s, c), f) ≡ c.
 * 검증 경로(codegen --check, 매니페스트 sha256 대조)와 중복되므로 프로덕션
 * 경로에 연결하지 않는다 — 문서·디버깅용 최소 구현.
 */
export function headerFor(content: string, fileName: string): string {
  const syntax = syntaxFor(fileName);
  if (syntax === 'none') return content;
  const allLines = content.split('\n');
  // shebang 변형: 첫 줄은 헤더가 아니라 원문이다 — 벗겨내지 말고 보존한다.
  const shebang = syntax === 'hash' && allLines[0]?.startsWith('#!') ? allLines[0] : null;
  const lines = shebang === null ? allLines : allLines.slice(1);
  // 헤더 블록의 경계는 대시 런 구분 라인이다 (첫 행만 'rustra generated' 각인).
  const isRuleLine = (line: string): boolean => /──{4,}/.test(line);
  const start = lines.findIndex(isRuleLine);
  if (start === -1) return content;
  const end = lines.findIndex((line, index) => index > start && isRuleLine(line));
  if (end === -1) return content;
  // 헤더 뒤의 빈 줄 하나는 generatedFileHeader 가 삽입한 것 — 함께 제거한다.
  const afterHeader = lines.slice(end + 1);
  if (afterHeader[0] === '') afterHeader.shift();
  return shebang === null ? afterHeader.join('\n') : `${shebang}\n${afterHeader.join('\n')}`;
}

type HeaderSyntax = 'slash' | 'hash' | 'xml' | 'none';

/** 파일 이름으로 헤더 문법을 판정한다. 기본값 slash — 기존 TS/C++/Kotlin 산출물 호환. */
function syntaxFor(fileName: string): HeaderSyntax {
  const base = fileName.split('/').pop() ?? fileName;
  if (base.endsWith('.json')) return 'none';
  if (/\.(xml|html|htm)$/.test(base)) return 'xml';
  if (
    base === 'CMakeLists.txt' ||
    /\.cmake$/.test(base) ||
    /\.(sh|podspec|rb|py|ya?ml|properties|toml|gitignore|env)$/.test(base)
  )
    return 'hash';
  return 'slash';
}

function commentToken(syntax: HeaderSyntax): string {
  if (syntax === 'hash') return '#';
  if (syntax === 'xml') return '<!--';
  return '//';
}

/** 헤더 블록(구분 라인 2개 사이 5행) + 빈 줄 하나를 조립한다. */
function headerLines(fileName: string, token: string, stage: string): string {
  if (token === '<!--') {
    // XML 주석 본문에는 `--` 가 금지다 — `--config` 를 `[config: ...]` 로 다시 표현한다.
    return [
      `<!-- ── rustra generated ──────────────────────────────────── -->`,
      `<!-- File:   ${fileName} -->`,
      `<!-- Source: schema.json (single source of truth for this file) -->`,
      `<!-- Regen:  rustra codegen [config: rustra.json] -->`,
      `<!-- Stage:  ${stage} -->`,
      `<!-- DO NOT EDIT — changes will be overwritten and fail codegen check. -->`,
      `<!-- ──────────────────────────────────────────────────────────── -->`,
      ``,
      ``,
    ].join('\n');
  }
  return [
    `${token} ── rustra generated ────────────────────────────────────────`,
    `${token} File:   ${fileName}`,
    `${token} Source: schema.json (single source of truth for this file)`,
    `${token} Regen:  rustra codegen --config rustra.json`,
    `${token} Stage:  ${stage}`,
    `${token} DO NOT EDIT — changes will be overwritten and fail codegen --check.`,
    `${token} ────────────────────────────────────────────────────────────`,
    ``,
    ``,
  ].join('\n');
}

function splitFirstLine(content: string): [string, string] {
  const index = content.indexOf('\n');
  if (index === -1) return [content, ''];
  return [content.slice(0, index), content.slice(index + 1)];
}
