import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { runParity } from './src/nitro-parity/run';
import { runDiagnostic } from './src/nitro-parity/diagnostic-run';
import { runProfileDiagnostic } from './src/nitro-parity/profile-run';

// Dedicated, automatic benchmark mode. No interactive input or legacy timings.
export default function NitroParityApp() {
  const [status, setStatus] = useState('Preparing Nitro parity benchmark');
  useEffect(() => {
    const run =
      process.env.EXPO_PUBLIC_PARITY_PROFILE === '1'
        ? runProfileDiagnostic
        : process.env.EXPO_PUBLIC_PARITY_DIAGNOSTIC === '1'
          ? runDiagnostic
          : runParity;
    run((message) => {
      console.log(`RUSTRA_PARITY_PROGRESS=${message}`);
      setStatus(message);
    })
      .then((receipt) =>
        setStatus(
          'iterations' in receipt
            ? `Profile complete: ${receipt.iterations} calls\n${receipt.runId}`
            : `Complete: ${'cases' in receipt ? receipt.cases.length : receipt.samples.length} results\n${receipt.runId}`,
        ),
      )
      .catch((error) => {
        const message = String(error);
        console.error(`RUSTRA_PARITY_FAILED=${message}`);
        setStatus(message);
      });
  }, []);
  return (
    <SafeAreaView>
      <Text>{status}</Text>
    </SafeAreaView>
  );
}
