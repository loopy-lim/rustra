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
    addNumbers({ a: 20, b: 22 })
      .then((out) => {
        setResult(out.value);
        // 성공 경로에서 Rust 결과값을 host 로 통보 (ack 왕복).
        // host stderr summary 의 resultAcked=1 val=42 가 rkyv 왕복의 증거.
        try {
          (getRustraNative() as { ackResult?: (v: number) => void }).ackResult?.(
            out.value,
          );
        } catch {
          // ackResult 미지원 — 무시
        }
      })
      .catch(() => setResult(-1)); // 폴백: -1 (Rust 결과 42 와 구분)
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
