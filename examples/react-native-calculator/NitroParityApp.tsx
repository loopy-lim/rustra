import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { runParity } from './src/nitro-parity/run';

// Dedicated, automatic benchmark mode. No interactive input or legacy timings.
export default function NitroParityApp() {
  const [status,setStatus]=useState('Preparing Nitro parity benchmark');
  useEffect(()=>{
    runParity(message=>{console.log(`RUSTRA_PARITY_PROGRESS=${message}`);setStatus(message);})
      .then(receipt=>setStatus(`Complete: ${receipt.cases.length} cases\n${receipt.runId}`))
      .catch(error=>{const message=String(error);console.error(`RUSTRA_PARITY_FAILED=${message}`);setStatus(message);});
  },[]);
  return <SafeAreaView><Text>{status}</Text></SafeAreaView>;
}
