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
   * 리로드 후 현재 상태를 기준과 대조한다. 불일치·capture 실패 모두
   * `ok: false` (loud 거부 — 호출자가 리로드를 되돌려야 한다). 판정이 끝난
   * 뒤 기준은 **현재 상태로 재무장**된다 — 재무장 없이는 합법적 스키마 변경
   * 이후 모든 리로드가 영원히 거부되는 쐐기가 된다. disarm 된 게이트는 항상
   * 통과(네이티브 dev 경로).
   */
  verify(): Promise<ParityVerdict>;
  /** 게이트를 끈다 — 다음 verify는 no-op 통과. */
  disarm(): void;
}

export function createParityGate(options: { capture: ParityCapture }): ParityGate {
  let baseline: ParitySnapshot | undefined;
  const { capture } = options;
  const rearm = async (): Promise<void> => {
    try {
      baseline = await capture();
    } catch {
      // 재무장 실패 — 다음 verify는 capture 실패 거부로 이어진다(fail-closed).
      // arm() 과 달리 판정 도중에는 throw 하지 않는다: 이미 관찰한 판정을
      // 뒤집지 않는다.
      baseline = undefined;
    }
  };
  return {
    async arm(): Promise<void> {
      // 기준 캡처 실패는 거부가 아니라 throw — 불일치 판정 전에 게이트가
      // 쓸 준비가 안 된 것이므로 호출자에게 즉시 보인다.
      baseline = await capture();
    },
    async verify(): Promise<ParityVerdict> {
      if (baseline === undefined) return { ok: true };
      let current: ParitySnapshot;
      try {
        current = await capture();
      } catch (error) {
        void rearm();
        return {
          ok: false,
          reason: `parity gate: capture failed after reload: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (current.contractHash !== baseline.contractHash) {
        void rearm();
        return {
          ok: false,
          reason:
            `parity gate: contract hash drift — before="${baseline.contractHash.slice(0, 16)}…" ` +
            `after="${current.contractHash.slice(0, 16)}…". The reload would change the wire ` +
            `contract; refusing it. Rebuild so the generated client and the engine agree.`,
        };
      }
      if (
        baseline.golden !== undefined &&
        current.golden !== undefined &&
        current.golden !== baseline.golden
      ) {
        void rearm();
        return {
          ok: false,
          reason:
            `parity gate: golden wire drift — before="${baseline.golden.slice(0, 16)}…" ` +
            `after="${current.golden.slice(0, 16)}…". Same-schema commands returned different ` +
            `bytes across the reload; refusing it.`,
        };
      }
      void rearm();
      return { ok: true };
    },
    disarm(): void {
      baseline = undefined;
    },
  };
}
