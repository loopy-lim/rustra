import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { add, readRemembered, remember, reset, safeDivide } from './generated/react-native';
import { runFunctionDemo, type FunctionDemoReceipt } from './src/function-demo';

/** Select with EXPO_PUBLIC_RUSTRA_DEMO=functions in a native build. */
export default function App() {
  const [receipt, setReceipt] = useState<FunctionDemoReceipt>();
  const [status, setStatus] = useState('Rust 함수를 확인하고 있습니다…');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    runFunctionDemo()
      .then((result) => {
        if (!active) return;
        setReceipt(result);
        setStatus('준비 완료 · Rust에 저장된 값: 0');
      })
      .catch((error: unknown) => {
        console.warn(`__RUSTRA_FUNCTIONS_FAIL__ ${String(error)}`);
        if (active) setStatus(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function run(action: 'add' | 'reset' | 'error') {
    setLoading(true);
    try {
      if (action === 'add') {
        const total = await add(42, 58);
        await remember(total);
        setStatus(`42 + 58 = ${total} · Rust에 저장된 값: ${await readRemembered()}`);
      } else if (action === 'reset') {
        await reset();
        setStatus(`reset() 완료 · Rust에 저장된 값: ${await readRemembered()}`);
      } else {
        await safeDivide(1, 0);
        setStatus('오류가 전달되지 않았습니다');
      }
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.eyebrow}>RUSTRA EXAMPLE</Text>
        <Text style={styles.title}>그냥 함수처럼.</Text>
        <Text style={styles.subtitle}>
          여러 인자와 반환값 없는 Rust 함수를 앱에서 바로 호출합니다.
        </Text>
        <View style={styles.card}>
          <Text style={styles.code}>fn add(a: i32, b: i32) → i32</Text>
          <Text style={styles.code}>await add(42, 58)</Text>
          <Text style={styles.code}>await reset() // void</Text>
        </View>
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {status}
        </Text>
        {loading && <ActivityIndicator accessibilityLabel="함수 확인 중" />}
        <View style={styles.actions}>
          <Button disabled={loading} onPress={() => run('add')} title="더하고 저장" />
          <Button disabled={loading} onPress={() => run('reset')} title="초기화" />
          <Button disabled={loading} onPress={() => run('error')} title="오류 확인" />
        </View>
        {receipt && (
          <>
            <Text style={styles.heading}>네이티브 검증 {receipt.checks.length}개 통과</Text>
            {receipt.checks.map((check) => (
              <Text key={check.name} style={styles.check}>
                ✓ {check.name}
              </Text>
            ))}
            {receipt.benchmark && (
              <View style={styles.card}>
                <Text style={styles.heading}>이 시뮬레이터의 측정값</Text>
                <Text style={styles.check}>
                  함수 호출:{' '}
                  {(receipt.benchmark.nanoseconds.generatedFunction.p50 / 1000).toFixed(2)} μs
                </Text>
                <Text style={styles.check}>
                  요청 인코딩: {receipt.benchmark.nanoseconds.encode.p50.toFixed(0)} ns
                </Text>
                <Text style={styles.check}>
                  버퍼 재사용: {receipt.benchmark.nanoseconds.encodeInto.p50.toFixed(0)} ns
                </Text>
                <Text style={styles.subtitle}>
                  Release · Hermes · 20개 표본. 실제 기기의 성능과 다를 수 있습니다.
                </Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f7fb' },
  container: { padding: 24, gap: 14 },
  eyebrow: { color: '#3563a0', fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: '#11243d', fontSize: 32, fontWeight: '800' },
  subtitle: { color: '#58687c', fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: '#fff', padding: 18, borderRadius: 16, gap: 10 },
  code: { color: '#193d65', fontFamily: 'Menlo', fontSize: 13 },
  status: { color: '#11243d', fontSize: 17, lineHeight: 25, fontWeight: '600' },
  actions: { gap: 8 },
  heading: { color: '#11243d', fontSize: 17, fontWeight: '700' },
  check: { color: '#29543d', fontSize: 13, lineHeight: 19 },
});
