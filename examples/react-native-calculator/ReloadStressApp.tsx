import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { configure } from '@rustra/types';
import { createAsyncEngine } from '../../packages/react-native/src';
import { rkyvV2Registry } from '../calculator/generated/rkyv-registry';
import { getRustraNative, installRustraJSI } from 'rustra-jsi';

const LOG_PREFIX = '[RustraReloadStress]';

function log(message: string): void {
  console.log(`${LOG_PREFIX} ${message}`);
}

/**
 * Development-only runtime reload probe.
 *
 * Each JS runtime installs JSI, proves a sync positional command, then leaves a
 * native async command in flight. The external stress runner reloads Metro as
 * soon as READY appears. A stale callback touching the old runtime would crash
 * the app; successful re-installation produces a new READY token instead.
 */
export default function ReloadStressApp() {
  const [status, setStatus] = useState('Installing JSI…');

  useEffect(() => {
    const token = String(Date.now());
    let active = true;

    async function run(): Promise<void> {
      try {
        await installRustraJSI();
        const native = getRustraNative();
        if (typeof native.invokeTypedPos !== 'function') {
          throw new Error('invokeTypedPos is unavailable');
        }

        const syncResult = native.invokeTypedPos(1, 42, 58) as { value?: unknown };
        if (syncResult?.value !== 100) {
          throw new Error(`sync probe returned ${JSON.stringify(syncResult)}`);
        }

        const engine = createAsyncEngine(native, { rkyvV2Codecs: rkyvV2Registry });
        configure(engine);
        if (active) setStatus(`READY ${token}`);
        log(`READY token=${token} value=100`);

        // Keep native work pending long enough for the external runner to
        // replace this Runtime. The C++ generation guard must discard the old
        // JS callbacks after module invalidation/re-installation.
        log(`PENDING token=${token}`);
        void engine
          .invoke<{ emitted: number }>('emitDemo', { ticks: 100, stepDelayMs: 10 })
          .then((result) => log(`ASYNC_COMPLETED token=${token} emitted=${result.emitted}`))
          .catch((error: unknown) =>
            log(
              `ASYNC_REJECTED token=${token} message=${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (active) setStatus(`FAILED ${message}`);
        console.error(`${LOG_PREFIX} FAILED token=${token} message=${message}`);
      }
    }

    void run();
    return () => {
      active = false;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Rustra reload stress</Text>
      <Text selectable style={styles.status} testID="reload-stress-status">
        {status}
      </Text>
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
  status: {
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
