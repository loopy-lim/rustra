import { useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { addNumbers } from './generated/react-native';

/** Minimal user-facing setup; the default app entry uses BenchmarkApp. */
export default function App() {
  const [status, setStatus] = useState('Ready');
  const [loading, setLoading] = useState(false);

  async function calculate() {
    setLoading(true);
    try {
      const result = await addNumbers({ a: 42, b: 58 });
      setStatus(`42 + 58 = ${result.value}`);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rustra calculator</Text>
      <Text accessibilityLiveRegion="polite" style={styles.result}>
        {status}
      </Text>
      <Button disabled={loading} onPress={calculate} title={loading ? 'Running…' : 'Run Rust'} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    flex: 1,
    gap: 16,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#111827',
    fontSize: 24,
    fontWeight: '700',
  },
  result: {
    color: '#374151',
    fontSize: 18,
  },
});
