/** CLI "Did you mean" 제안 — 편집 거리로 최근접 후보를 고린다. */

/**
 * 두 문자열의 Levenshtein 편집 거리(삽입/삭제/치환). 두 행 DP로
 * O(len(left)×len(right)) — 후보 수가 적은 CLI 나열에 충분하다.
 */
export function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++)
      current.push(
        left[i] === right[j]
          ? previous[j]!
          : 1 + Math.min(previous[j]!, previous[j + 1]!, current[j]!),
      );
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

/**
 * `input` 과 편집 거리 `maxDistance` 이하인 후보 중 가장 가까운 것을 반환한다.
 * 동률은 먼저 나온 후보가 이긴다. 없으면 undefined.
 *
 * 대소문자 처리는 호출자 관례를 따른다 — 커맨드/플래그는 구분 비교,
 * config 키는 `closestKey` 래퍼가 소문자로 맞춰 비교한다(기존 드리프트 유지).
 */
export function closestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance <= maxDistance && (!best || distance < best.distance))
      best = { candidate, distance };
  }
  return best?.candidate;
}
