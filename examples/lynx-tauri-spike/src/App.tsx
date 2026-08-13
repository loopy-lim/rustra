import { useEffect, useState } from '@lynx-js/react';
import { addNumbers } from '../../calculator/generated/commands.js';
import { createFastEngine, configure, getRustraNative } from '@rustra/lynx';
import { rkyvV2Registry } from '../../calculator/generated/rkyv-registry.js';

// 스파이크 프론트: addNumbers(20,22) → rkyv V2 fast-path → 결과 42 를 화면에 띄운다.
// 데스크톱 호스트(C++)가 NativeModules.RustraModule 을 등록했는지에 따라 엔진 설정이
// 결정된다. 미등록(빌드 단계/헤드리스)이면 configure 를 건너뛰고 호출별로 폴백한다.
try {
  configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
} catch {
  // 네이티브 모듈 미등록 — 빌드는 계속 진행된다.
}

export function App() {
  // addNumbers(20, 22) 의 Rust 결과는 42 이다. 초기값 null → 폴백/대기와 구분.
  const [result, setResult] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const native = getRustraNative() as {
      ackResult?: (v: number) => void;
      benchResult?: (label: string, value: number) => void;
    };
    // QuickJS end-to-end 측정값을 host 로 중계 → [bench] js.* 라인.
    const bench = (label: string, value: number) => {
      try {
        native.benchResult?.(label, value);
      } catch {
        // benchResult 미지원 — 무시
      }
    };
    // performance.now() 가 없는 QuickJS 폴백(Date.now, ms 해상도).
    const now = () => {
      const p = (globalThis as { performance?: { now?: () => number } })
        .performance;
      return typeof p?.now === 'function' ? p.now() : Date.now();
    };
    const hasHiRes =
      typeof (globalThis as { performance?: { now?: () => number } }).performance
        ?.now === 'function';

    (async () => {
      try {
        // warmup — QuickJS/N-API 경로 안정화.
        for (let i = 0; i < 50; i++) await addNumbers({ a: 20, b: 22 });
        if (cancelled) return;

        const N = 500;
        const times: number[] = [];
        const tBatch0 = now();
        for (let i = 0; i < N; i++) {
          const t0 = now();
          const out = await addNumbers({ a: 20, b: 22 });
          times.push(now() - t0);
          // 첫 호출은 verify.sh 호환성(resultAcked=1 val=42) 유지.
          if (i === 0) {
            setResult(out.value);
            try {
              native.ackResult?.(out.value);
            } catch {
              // ackResult 미지원 — 무시
            }
          }
        }
        if (cancelled) return;
        const batchMs = now() - tBatch0;

        times.sort((a, b) => a - b);
        const pct = (q: number) =>
          times[Math.min(Math.floor((q / 100) * times.length), times.length - 1)];
        const avg = times.reduce((s, x) => s + x, 0) / times.length;
        bench('js.n', times.length);
        bench('js.hires', hasHiRes ? 1 : 0);
        bench('js.batch_ms_total', Number(batchMs.toFixed(3)));
        bench('js.avg_us', Number((avg * 1000).toFixed(2)));
        if (hasHiRes) {
          // Date.now() 폴백에서는 개별 호출이 0ms 로 떨어져 p50/p99 무의미.
          bench('js.p50_us', Number((pct(50) * 1000).toFixed(2)));
          bench('js.p99_us', Number((pct(99) * 1000).toFixed(2)));
        }
      } catch {
        setResult(-1); // 폴백: -1 (Rust 결과 42 와 구분)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <view
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: '#1a1a2e',
        paddingTop: 120,
        paddingLeft: 32,
        paddingRight: 32,
      }}
    >
      <text style={{ color: '#e94560', fontSize: 36, fontWeight: '700' }}>
        rustra + Lynx + Tauri
      </text>
      <text style={{ color: '#ffffff', fontSize: 22, marginTop: 28 }}>
        addNumbers(20, 22)
      </text>
      <text
        style={{
          color: '#ffffff',
          fontSize: 30,
          marginTop: 24,
          backgroundColor: '#e94560',
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 24,
          paddingRight: 24,
          alignSelf: 'flex-start',
        }}
      >
        result: {result ?? '—'}
      </text>
    </view>
  );
}
