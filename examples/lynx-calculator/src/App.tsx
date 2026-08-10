import { useEffect, useState } from '@lynx-js/react';
import { addNumbers, divide, secureCompute } from '../../calculator/generated/commands.js';
import {
  createFastEngine,
  configure,
  getRustraNative,
  subscribeTick,
  RustraCommandError,
} from '@rustra/lynx';
import { rkyvV2Registry } from '../../calculator/generated/rkyv-registry.js';

// rkyv V2 fast-path 엔진을 한 번 설정한다. 헤드리스/CI 렌더에서는 네이티브
// 모듈이 등록되어 있지 않을 수 있어 configure 를 건너뛰고 호출별로 폴백한다.
try {
  configure(createFastEngine(getRustraNative(), { rkyvV2Codecs: rkyvV2Registry }));
} catch {
  // 네이티브 모듈 사용 불가 — 렌더는 계속 진행된다.
}

export function App() {
  // addNumbers(20, 22) 의 Rust 구현 결과는 42 이다.
  const [result, setResult] = useState<number | null>(null);
  // Rust/host → ReactLynx 이벤트 푸시(Phase A Task 2): 호스트가 BTS 에서
  // 주기적으로 보내는 tick 카운터. 초기값 -1 로 두어 폴백과 구분한다.
  const [tick, setTick] = useState<number>(-1);
  // Criterion 6 (typed error roundtrip): divide(1,0) 은 Rust 가
  // RustraError{code:"math.divide_by_zero"} 를 반환하고, 그 code 가 구조체 그대로
  // 와이어를 넘어 JS RustraCommandError.code 로 재구성되어야 한다. 초기값 null.
  const [errCode, setErrCode] = useState<string | null>(null);
  // Criterion 8 (deny-by-default authority): secureCompute 는 capability
  // "compute:secure" 를 요구하지만 런타임에 부여된 적이 없으므로 deny 된다.
  // Rust Runtime Authority 가 핸들러 호출 전에 capability.denied 를 반환하고,
  // 그 code 가 와이어를 넘어 JS 로 재구성되어야 한다. 초기값 null.
  const [capDenied, setCapDenied] = useState<string | null>(null);

  useEffect(() => {
    addNumbers({ a: 20, b: 22 })
      .then((out) => {
        // AddNumbersOutput = { value: number }; 화면엔 값만 표시한다.
        setResult(out.value);
        // 성공 경로에서만 Rust 결과값을 host 로 통보 (ack 왕복).
        // resultAcked=1 val=42 이면 폴백 없이 Rust 결과가 도달한 것.
        try {
          (getRustraNative() as unknown as { ackResult?: (v: number) => void })
            .ackResult?.(out.value);
        } catch {
          // ackResult 미지원 — 무시
        }
      })
      .catch(() => setResult(-1)); // 폴백: -1 (Rust 결과 42 와 구분)
    // Criterion 6: 0 나누기 → Rust typed error. RustraError.code 가 구조체 그대로
    // 와이어를 넘어 RustraCommandError.code 로 재구성되는지 검증한다. 폴백(plain
    // Error)이면 이 분기에 들지 못한다 — RustraCommandError 여부가 곧 증거.
    divide({ a: 1, b: 0 })
      .then(() => {
        // 도달하면 안 됨 — Rust 가 Err 를 반환해야 정상.
        setErrCode('no-error');
      })
      .catch((err: unknown) => {
        if (err instanceof RustraCommandError) {
          setErrCode(err.code);
          // code 가 구조체 그대로 보존되었음을 host 로 통보 (ack 왕복).
          // summary 의 errAcked=1 code=math.divide_by_zero 가 criterion 6 의 증거.
          if (err.code === 'math.divide_by_zero') {
            try {
              (getRustraNative() as unknown as { ackError?: (c: string) => void })
                .ackError?.(err.code);
            } catch {
              // ackError 미지원 — 무시
            }
          }
        } else {
          setErrCode('wrong-err-type');
        }
      });
    // Criterion 8 (deny-by-default authority): secureCompute 는 capability
    // "compute:secure" 가 부여되지 않았으므로 Runtime Authority 가 핸들러 호출 전에
    // capability.denied 로 거부한다. 폴백(plain Error)이면 이 분기에 들지 못한다 —
    // RustraCommandError 여부가 곧 authority 가 동작한 증거.
    secureCompute({ a: 6, b: 7 })
      .then(() => {
        // 도달하면 안 됨 — capability 가 부여되지 않았으므로 deny 되어야 정상.
        setCapDenied('allowed-unexpected');
      })
      .catch((err: unknown) => {
        if (err instanceof RustraCommandError) {
          setCapDenied(err.code);
          // capability.denied code 가 구조체 그대로 보존되었음을 host 로 통보.
          // summary 의 capAcked=1 capCode=capability.denied 가 criterion 8 의 증거.
          if (err.code === 'capability.denied') {
            try {
              (getRustraNative() as unknown as { ackCapability?: (c: string) => void })
                .ackCapability?.(err.code);
            } catch {
              // ackCapability 미지원 — 무시
            }
          }
        } else {
          setCapDenied('wrong-err-type');
        }
      });
    // Rust/host → JS 이벤트 푸시 경로 검증
    try {
      subscribeTick((n) => {
        setTick(n);
        // host 로 deliver 가 JS 에서 실제 처리되었음을 확인 (ack 왕복)
        try {
          (getRustraNative() as unknown as { ackTick?: () => void }).ackTick?.();
        } catch {
          // ackTick 미지원 — 무시
        }
      });
    } catch {
      // subscribeTick 미지원 호스트 — 무시
    }
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
      <text style={{ color: '#e94560', fontSize: 22, marginTop: 36 }}>
        tick (host→js push)
      </text>
      <text style={{ color: '#ffffff', fontSize: 30, marginTop: 12 }}>
        {tick < 0 ? 'waiting…' : tick}
      </text>
      <text style={{ color: '#e94560', fontSize: 22, marginTop: 36 }}>
        err (typed roundtrip)
      </text>
      <text style={{ color: '#ffffff', fontSize: 24, marginTop: 12 }}>
        {errCode ?? '—'}
      </text>
      <text style={{ color: '#e94560', fontSize: 22, marginTop: 36 }}>
        cap (deny-by-default)
      </text>
      <text style={{ color: '#ffffff', fontSize: 24, marginTop: 12 }}>
        {capDenied ?? '—'}
      </text>
    </view>
  );
}
