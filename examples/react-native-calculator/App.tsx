import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { addNumbers } from '../calculator/generated/commands';
import { createReactNativeEngine } from '../../packages/react-native/src';
import RustraCalculatorModule from './modules/rustra-calculator';

type RustraNativeModule = {
  invoke(command: string, args?: unknown): Promise<unknown>;
};

const nativeModule = RustraCalculatorModule as RustraNativeModule;

export default function App() {
  const [result, setResult] = useState('pending');

  useEffect(() => {
    const engine = createReactNativeEngine(nativeModule);

    addNumbers(engine, { a: 20, b: 22 })
      .then((output) => setResult(String(output.value)))
      .catch((error: unknown) => setResult(String(error)));
  }, []);

  return (
    <View style={styles.container}>
      <Text testID="rustra-result">{result}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
