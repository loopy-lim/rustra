import { useEffect, useState } from '@lynx-js/react';
import { configure, createFastEngine, getRustraNative } from '@rustra/lynx';
import { greet, readConfig } from '../generated/commands.js';
import { rkyvV2Registry } from '../generated/rkyv-registry.js';

// 템플릿 프론트: greet({ name: "rustra" }) → rkyv V2 fast-path → "Hello, rustra!" 표시.
// 추가: readConfig() → capability 계층 B(FileCap) 를 통한 플랫폼 파일 읽기 증명.
//   - Desktop: std::fs (DesktopRegistry — lynx_template_init 가 주입)
//   - iOS: NSBundle (MobileBridge.read_file — RustraModule +load 가 주입)
//   - Android: assets (MobileBridge.read_file — RustraModule init 이 주입)
//
// generated/ 는 Rust 백엔드(backend/src/lib.rs 의 #[command]) 로부터 codegen 한 결과.
// ▶ 첫 실행 전: `npm run codegen` (또는 create-runner.sh 가 자동 수행).
//
// 각 플랫폼 셸(Desktop host / iOS·Android RustraModule)이 NativeModules.RustraModule
// (invokeRkyvV2) 를 주입했는지로 엔진 설정이 결정된다. 미등록(빌드 단계/헤드리스)이면
// configure 를 건너뛴다 — 번들이 빌드되려면 네이티브 미주입도 허용해야 한다.
try {
  configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
} catch {
  // 네이티브 모듈 미등록 — 빌드는 계속 진행된다.
}

export function App() {
  // greet({ name: "rustra" }) 의 Rust 결과는 "Hello, rustra!". 초기값 null → 대기와 구분.
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // readConfig() 결과 — config.json 의 내용(플랫폼 파일 읽기). 실패 시 에러 코드 표시.
  const [config, setConfig] = useState<string | null>(null);

  useEffect(() => {
    greet({ name: 'rustra' })
      .then((out) => {
        setMessage(out.message);
        // 데스크톱 호스트의 최종 확인(게이트가 resultAcked 를 grep) — 결과 길이를 전달.
        // 모바일(ios/Android) RustraModule 은 ackResult 가 없으므로 optional-chaining + try.
        try {
          const native = globalThis as unknown as { RustraModule?: { ackResult?: (v: number) => void } };
          native.RustraModule?.ackResult?.(out.message.length);
        } catch {
          // ackResult 미지원 — 무시
        }
      })
      .catch((e) => setError(String(e)));

    // capability 계층 B: FileCap.read_file("config.json") via rkyv V2 (동일 와이어).
    readConfig({})
      .then((out) => setConfig(out.content))
      .catch((e) => setConfig(`capability error: ${e instanceof Error ? e.message : String(e)}`));
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
        rustra + Lynx
      </text>
      <text style={{ color: '#ffffff', fontSize: 22, marginTop: 28 }}>
        greet(&quot;rustra&quot;)
      </text>
      <text
        style={{
          color: '#ffffff',
          fontSize: 24,
          marginTop: 24,
          backgroundColor: '#e94560',
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 24,
          paddingRight: 24,
          alignSelf: 'flex-start',
        }}
      >
        {message ?? (error ? `error: ${error}` : '—')}
      </text>
      <text style={{ color: '#8899aa', fontSize: 18, marginTop: 32 }}>
        readConfig (FileCap)
      </text>
      <text style={{ color: '#ffffff', fontSize: 18, marginTop: 12 }}>
        {config ?? '—'}
      </text>
    </view>
  );
}
