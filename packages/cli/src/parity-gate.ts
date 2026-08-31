/**
 * Parity gate (Task A2, dev-tooling) — `dev.wasm.parityGate: true`(기본)일 때
 * dev 루프가 reload 전후의 계약 상태를 대조해 불일치 시 리로드를 거부한다.
 *
 * 비교 대상은 두 가지다:
 * - `contractHash` — `rustra_ffi_contract_hash` 가 반환하는 SHA-256 hex.
 * - `golden` — 호스트가 정한 golden wire 호출의 응답 바이트 표현(hex 등).
 *
 * capture/verify 방법은 호스트가 주입한다 — 이 모듈은 순수 비교+거부
 * 오케스트레이션이다(네이티브/웹즈 런타임에 의존하지 않는다). capture 실패도
 * 불일치로 취급한다: 검증 불가능한 리로드는 통과시키지 않는다(fail-closed).
 */

/** reload 전후로 대조하는 계약 상태 스냅샷. */
export interface ParitySnapshot {
  /** `rustra_ffi_contract_hash` 값(SHA-256 hex) — 빌드타임 계약과 갈라질 수 없다. */
  contractHash: string;
  /**
   * golden wire 호출의 응답 바이트 표현(호스트가 인코딩 — 보통 hex). 라이브
   * 엔진이 있을 때만 채울 수 있다 — 빌드타임 상태만 보는 capture(예: dev 루프의
   * schema.json 해시)는 생략한다. 한쪽이라도 정의되어 있으면 대조하고, 양쪽 다
   * 없으면 건너뛴다(대조할 것이 없는 것은 불일치가 아니다).
   */
  golden?: string;
}

export type ParityCapture = () => Promise<ParitySnapshot>;

export type ParityVerdict = { ok: true; reason?: undefined } | { ok: false; reason: string };

export interface ParityGate {
  /** 리로드 전 기준 스냅샷을 잡는다. 실패 시 throw — 게이트 없이 진행 금지. */
  arm(): Promise<void>;
  /**
   * 현재 상태를 capture 해 기준과 대조한다(리로드 신호 방출 전 — 빌드 직후
   * 상태를 대조하는 것이 호출자의 배선 계약이다). 불일치·capture 실패 모두
   * `ok: false` (fail-closed — 호출자는 리로드를 방출해선 안 된다). capture
   * 실패 시 기준은 **버려지지 않는다** — 마지막으로 알려진 상태가 다음 판정의
   * 대조 기준으로 남아, capture 가 복구된 첫 판정이 곧 재시도가 된다. 캡처에
   * 성공한 판정이 끝나면 기준은 그 상태로 **재무장**된다 — 재무장 없이는
   * 합법적 스키마 변경 이후 모든 리로드가 영원히 거부되는 쐐기가 된다.
   * 무조건 통과하는 유일한 길은 명시적 disarm 뿐이다(네이티브 dev 경로).
   */
  verify(): Promise<ParityVerdict>;
  /** 게이트를 끈다 — 다음 verify는 no-op 통과. */
  disarm(): void;
}

export function createParityGate(options: { capture: ParityCapture }): ParityGate {
  let baseline: ParitySnapshot | undefined;
  const { capture } = options;
  return {
    async arm(): Promise<void> {
      // 기준 캡처 실패는 거부가 아니라 throw — 불일치 판정 전에 게이트가
      // 쓸 준비가 안 된 것이므로 호출자에게 즉시 보인다.
      baseline = await capture();
    },
    async verify(): Promise<ParityVerdict> {
      // undefined 는 명시적 disarm 뿐이다 — 판정 실패로 기준이 사라지는 경로는
      // 존재하지 않는다(fail-open 금지: 한 번의 실패가 이후 리로드를 조용히
      // 전부 통과시키는 일이 없어야 한다).
      if (baseline === undefined) return { ok: true };
      let current: ParitySnapshot;
      try {
        current = await capture();
      } catch (error) {
        // capture 실패 — 대조 불가능한 리로드는 통과시키지 않는다(fail-closed).
        // 기준을 유지하므로 다음 verify 의 capture 가 곧 재시도다: 복구되면
        // 유지된 기준과의 실제 대조로 이어지고, 계속 실패하면 계속 거부된다.
        return {
          ok: false,
          reason: `parity gate: capture failed — refusing the reload: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (current.contractHash !== baseline.contractHash) {
        const before = baseline.contractHash;
        // 재무장 — 기준을 관찰된 현재 상태로 옮긴다. 거부가 이후 리로드를
        // 영원히 묶어두는 쐐기가 되지 않게 하기 위함이다.
        baseline = current;
        return {
          ok: false,
          reason:
            `parity gate: contract hash drift — before="${before.slice(0, 16)}…" ` +
            `after="${current.contractHash.slice(0, 16)}…". The reload would change the wire ` +
            `contract; refusing it. Rebuild so the generated client and the engine agree.`,
        };
      }
      if (
        baseline.golden !== undefined &&
        current.golden !== undefined &&
        current.golden !== baseline.golden
      ) {
        const before = baseline.golden;
        baseline = current;
        return {
          ok: false,
          reason:
            `parity gate: golden wire drift — before="${before.slice(0, 16)}…" ` +
            `after="${current.golden.slice(0, 16)}…". Same-schema commands returned different ` +
            `bytes across the reload; refusing it.`,
        };
      }
      baseline = current;
      return { ok: true };
    },
    disarm(): void {
      baseline = undefined;
    },
  };
}
