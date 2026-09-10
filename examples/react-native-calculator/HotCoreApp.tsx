import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { configure } from '@rustra/types';
import { createFastEngine } from '../../packages/react-native/src';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from './generated/contract';
import { rkyvV2Registry } from './generated/rkyv-registry';
import { getRustraNative, installRustraJSI } from '@rustra/generated-react-native';

const LOG_PREFIX = '[RustraHotCore]';
const ADD_NUMBERS_NAME = 'addNumbers';
// 1초 주기 프로브 — 스왑 감지(코어 300ms 폴링)보다 느리므로 스왑 후 첫 틱에서
// 값이 바뀐다. 로그 관측 계약: baseline addNumbers=5 → behavior 스왑 후 105.
const PROBE_INTERVAL_MS = 1_000;

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/** dev 핫코어 상태 스냅샷 — 네이티브가 미노출(구형 네이티브/비활성)이면 null. */
type HotCoreSnapshot = {
  enabled: boolean;
  swapped: boolean;
  oldHash: string;
  newHash: string;
  error: string;
};

/** C++ 코어의 hotCoreStatus() 선택 표면을 안전하게 읽는다(미노출 시 null). */
function readHotCoreSnapshot(native: unknown): HotCoreSnapshot | null {
  const probe = native as { hotCoreStatus?: () => unknown };
  const read = probe?.hotCoreStatus;
  if (typeof read !== 'function') return null;
  try {
    const value = read.call(probe) as Partial<HotCoreSnapshot> | null | undefined;
    if (!value || typeof value !== 'object') return null;
    return {
      enabled: value.enabled === true,
      swapped: value.swapped === true,
      oldHash: typeof value.oldHash === 'string' ? value.oldHash : '',
      newHash: typeof value.newHash === 'string' ? value.newHash : '',
      error: typeof value.error === 'string' ? value.error : '',
    };
  } catch {
    return null;
  }
}

/** UI용 한 줄 요약 — 스왑 전엔 enabled 만, 실패 시 error 를 함께 보인다. */
function summarizeSnapshot(snapshot: HotCoreSnapshot | null): string | undefined {
  if (!snapshot) return undefined;
  const parts = [`hot=${snapshot.enabled ? 'on' : 'off'}`];
  if (snapshot.swapped) parts.push('swapped=yes');
  if (snapshot.error) parts.push(`error=${snapshot.error}`);
  return parts.join(' ');
}

/**
 * Android 핫 코어 스왑 스모크 전용 dev 앱.
 *
 * 설치 직후 JSI positional 진입으로 addNumbers(2,3)=5 를 1초마다 호출한다.
 * 외부 스크립트(scripts/hot-core-push-android.mjs)가 behavior 변형 cdylib
 * (a+b+100)을 <filesDir>/rustra/hot 로 원자 전달하면, 코어의 300ms 폴링이
 * 스왑하고 **JS 재로드 없이** 같은 로그 시퀀스에서 105 로 바뀌는지 관측한다.
 * Metro reload 가 끼면 관측이 무효가 되므로 이 앱은 reload 트리거를 갖지 않는다.
 */
export default function HotCoreApp() {
  const [status, setStatus] = useState('Installing JSI…');
  const [coreStatus, setCoreStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval> | undefined;

    async function run(): Promise<void> {
      try {
        await installRustraJSI();
        const native = getRustraNative();
        // 클로저 안에서도 narrowing 이 유지되도록 const 에 옮긴다.
        const invokeTypedPos = native.invokeTypedPos;
        if (typeof invokeTypedPos !== 'function') {
          throw new Error('invokeTypedPos is unavailable');
        }
        const addId = rkyvV2Registry.get(ADD_NUMBERS_NAME)!.commandId;
        const invokeAdd = (): number => {
          const result = invokeTypedPos(addId, 2, 3) as { value?: unknown };
          if (result === null || typeof result !== 'object' || typeof result.value !== 'number') {
            throw new Error(`addNumbers returned ${JSON.stringify(result)}`);
          }
          return result.value;
        };

        const baseline = invokeAdd();
        configure(
          createFastEngine(native, {
            rkyvV2Codecs: rkyvV2Registry,
            contractHash: GENERATED_CONTRACT_HASH,
            schemaVersion: SCHEMA_VERSION,
          }),
        );
        if (active) setStatus(`READY addNumbers=${baseline}`);
        log(`READY value=${baseline}`);
        setCoreStatus(summarizeSnapshot(readHotCoreSnapshot(native)));

        interval = setInterval(() => {
          try {
            const value = invokeAdd();
            const snapshot = readHotCoreSnapshot(native);
            const statusText = summarizeSnapshot(snapshot);
            if (statusText !== undefined) setCoreStatus(statusText);
            // hash 는 현재 서비스 중인 코어의 계약 해시 8자다 — 스왑 성공 시 신
            // 코어가 보고한 newHash, 그 외엔 정적 계약 해시(스왑 관측의 1차
            // 신호는 값 변화고 hash 는 보조 식별자다).
            const currentHash =
              snapshot?.swapped && snapshot.newHash ? snapshot.newHash : GENERATED_CONTRACT_HASH;
            log(`addNumbers=${value} hash=${currentHash.slice(0, 8)}`);
            if (active) setStatus(`addNumbers=${value}`);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            log(`FAILED message=${message}`);
            if (active) setStatus(`FAILED ${message}`);
          }
        }, PROBE_INTERVAL_MS);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (active) setStatus(`FAILED ${message}`);
        console.error(`${LOG_PREFIX} FAILED message=${message}`);
      }
    }

    void run();
    return () => {
      active = false;
      if (interval !== undefined) clearInterval(interval);
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rustra hot core smoke</Text>
      <Text selectable style={styles.result} testID="hot-core-status">
        {status}
      </Text>
      {coreStatus !== undefined ? (
        <Text selectable style={styles.coreStatus}>
          hotCoreStatus: {coreStatus}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#111827',
    flex: 1,
    gap: 16,
    justifyContent: 'center',
    padding: 24,
  },
  coreStatus: {
    color: '#a5b4fc',
    fontFamily: 'Courier',
    fontSize: 12,
    textAlign: 'center',
  },
  result: {
    color: '#93c5fd',
    fontFamily: 'Courier',
    fontSize: 14,
    textAlign: 'center',
  },
  title: {
    color: '#f9fafb',
    fontSize: 24,
    fontWeight: '700',
  },
});
