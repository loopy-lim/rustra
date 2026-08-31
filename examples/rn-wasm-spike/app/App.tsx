// App.tsx — wasm swap spike control panel.
//
// Flow (matches docs/plans Task A0 step 3):
//   1. load bundled engine_v1.wasm into wasm3 (engineVersion=2)
//   2. run identical command bytes through BOTH engines (wasm3 + staticlib)
//      and compare hex — must be byte-identical
//   3. swap: push engine_v2.wasm (factor=3) + tap "swap->v2" — NO app
//      restart — and the SAME command bytes must now produce new bytes
//      ({"value":63} for double(21)) with an UNCHANGED contract hash
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  evalCommandNative,
  evalCommandWasm,
  loadBundledEngine,
  makeEnvelope,
  reloadSwappedEngine,
  spikeAvailable,
} from './modules/RustraWasmSpike/src';

type LogLine = { t: string; text: string; kind: 'info' | 'ok' | 'fail' | 'hex' };

const DOUBLE_21 = { command: 'double', args: { n: 21 } };
const ADD_40_2 = { command: 'addNumbers', args: { a: 40, b: 2 } };

export default function App() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const logRef = useRef<LogLine[]>([]);
  const contractHash = useRef<string>('');

  const log = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    const t = new Date().toISOString();
    const line = { t, text, kind };
    logRef.current = [...logRef.current, line];
    setLines(logRef.current);
    // mirror to console for `log stream` / logcat capture
    console.log(`[spike][${kind}] ${text}`);
  }, []);

  const compareBoth = useCallback(
    async (label: string, command: string, args: object) => {
      const env = await makeEnvelope(command, JSON.stringify(args));
      const envHex = env.map((b) => b.toString(16).padStart(2, '0')).join('');
      log(`${label} envelope (${env.length}B): ${envHex}`, 'hex');
      const wasm = await evalCommandWasm(env);
      const native = await evalCommandNative(env);
      log(`${label} wasm   (${wasm.ms.toFixed(3)}ms): ${wasm.hex}`, 'hex');
      log(`${label} native (${native.ms.toFixed(3)}ms): ${native.hex}`, 'hex');
      const equal = wasm.hex === native.hex;
      log(`${label} => ${equal ? 'BYTE-IDENTICAL' : 'MISMATCH'}`, equal ? 'ok' : 'fail');
      return { wasm: wasm.hex, native: native.hex, equal };
    },
    [log],
  );

  const onInit = useCallback(async () => {
    try {
      log('init: loading bundled engine_v1.wasm into wasm3…');
      const res = await loadBundledEngine();
      contractHash.current = res.contractHash;
      log(
        `instantiated: engineVersion=${res.engineVersion} hash=${res.contractHash} in ${res.instantiateMs.toFixed(1)}ms`,
        'ok',
      );
      await compareBoth('double(21)', DOUBLE_21.command, DOUBLE_21.args);
      await compareBoth('addNumbers(40,2)', ADD_40_2.command, ADD_40_2.args);
    } catch (e) {
      log(`init FAILED: ${String((e as Error).message ?? e)}`, 'fail');
    }
  }, [compareBoth, log]);

  const onRecall = useCallback(async () => {
    try {
      await compareBoth('double(21)', DOUBLE_21.command, DOUBLE_21.args);
      await compareBoth('addNumbers(40,2)', ADD_40_2.command, ADD_40_2.args);
    } catch (e) {
      log(`recall FAILED: ${String((e as Error).message ?? e)}`, 'fail');
    }
  }, [compareBoth, log]);

  const onSwap = useCallback(async (): Promise<void> => {
    log('swap: reloading engine_v2.wasm (factor=3) WITHOUT app restart…');
    try {
      const res = await reloadSwappedEngine();
      const hashUnchanged = res.contractHash === contractHash.current;
      log(
        `reloaded: engineVersion=${res.engineVersion} hash=${res.contractHash} in ${res.instantiateMs.toFixed(1)}ms — hash ${hashUnchanged ? 'UNCHANGED (contract stable)' : 'CHANGED (contract broke!)'}`,
        hashUnchanged ? 'ok' : 'fail',
      );
      await compareBoth('double(21)', DOUBLE_21.command, DOUBLE_21.args);
      await compareBoth('addNumbers(40,2)', ADD_40_2.command, ADD_40_2.args);
    } catch (e) {
      // Re-throw so the auto-poll keeps waiting (files/engine_v2.wasm not
      // pushed yet is retryable, not terminal).
      log(`swap FAILED: ${String((e as Error).message ?? e)}`, 'fail');
      throw e;
    }
  }, [compareBoth, log]);

  // Auto-run the full evidence sequence on mount so a single headless launch
  // (simctl/adb) captures: v1 instantiate + wasm/native compare, then the
  // NO-RESTART swap to v2 + recompare. The v2 .wasm is pushed externally
  // (simctl/adb) WHILE the app runs — like an OTA drop — so we poll for it.
  // Buttons stay for manual replay.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void (async () => {
      await onInit();
      log('auto: waiting for engine_v2.wasm to be pushed (polling up to 120s)…');
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        try {
          await onSwap();
          return;
        } catch {
          /* not pushed yet — keep polling */
        }
      }
      log('auto: gave up waiting for engine_v2.wasm', 'fail');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.screen}>
      <Text style={styles.h1}>rustra x wasm3 swap spike</Text>
      <View style={styles.row}>
        <Pressable style={styles.btn} onPress={onInit}>
          <Text style={styles.btnText}>1. init + compare</Text>
        </Pressable>
        <Pressable style={styles.btn} onPress={onRecall}>
          <Text style={styles.btnText}>2. recall</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.swap]} onPress={onSwap} disabled={!spikeAvailable}>
          <Text style={styles.btnText}>3. swap to v2</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.logBox}>
        {lines.map((l, i) => (
          <Text key={i} style={[styles.line, styles[l.kind]]} selectable>
            {l.t.slice(11, 23)} {l.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 60, paddingHorizontal: 12, backgroundColor: '#0b0f14' },
  h1: { color: '#e6edf3', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  btn: {
    backgroundColor: '#21262d',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  swap: { backgroundColor: '#1f6feb', borderColor: '#388bfd' },
  btnText: { color: '#e6edf3', fontWeight: '600' },
  logBox: { flex: 1, borderColor: '#30363d', borderWidth: 1, borderRadius: 6, padding: 6 },
  line: { fontFamily: 'Menlo', fontSize: 10, marginBottom: 2 },
  info: { color: '#8b949e' },
  ok: { color: '#3fb950' },
  fail: { color: '#f85149' },
  hex: { color: '#79c0ff' },
});
