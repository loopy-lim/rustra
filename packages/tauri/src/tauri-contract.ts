import { normalizeRustraError, RustraCommandError, RustraErrorCode } from '@rustra/types';
import type { TauriEngineOptions, TauriInvoke } from './index.js';

/** Share one successful startup handshake; a failed attempt can be retried. */
export function createTauriContractVerifier(invoke: TauriInvoke, options: TauriEngineOptions) {
  let verification: Promise<void> | undefined;
  const check = async () => {
    if (options.contractHash === undefined || options.contractVerification === 'off') return;
    try {
      let native: unknown;
      try {
        native = await invoke('rustra_contract_hash', { expectedHash: options.contractHash });
      } catch (error) {
        const normalized = normalizeRustraError(error);
        if (
          normalized.code === RustraErrorCode.ContractMismatch ||
          normalized.code === RustraErrorCode.ContractUnenforceable
        )
          throw normalized;
        throw new RustraCommandError(
          RustraErrorCode.ContractUnenforceable,
          error === 'Command rustra_contract_hash not found'
            ? 'Tauri native endpoint rustra_contract_hash is not registered. Register the Rust package with rustra::tauri_support::register_with_events() and rebuild the host. A later .invoke_handler() replaces that registration; combine app commands with rustra::tauri_support::with_app_commands() instead.'
            : 'Tauri contract verification is unavailable. Rebuild the Rust host with the current Rustra registration helpers.',
          false,
          error,
        );
      }
      if (typeof native !== 'string' || native.trim() === '') {
        throw new RustraCommandError(
          RustraErrorCode.ContractUnenforceable,
          'Tauri rustra_contract_hash returned an invalid contract hash',
        );
      }
      if (native.trim() !== options.contractHash) {
        throw new RustraCommandError(
          RustraErrorCode.ContractMismatch,
          `Tauri contract hash mismatch: native="${native.slice(0, 16)}…" vs expected="${options.contractHash.slice(0, 16)}…". Regenerate the client and rebuild the Rust host.`,
        );
      }
    } catch (error) {
      if (options.contractVerification !== 'warn') throw error;
      console.warn(
        `[rustra] ${error instanceof Error ? error.message : String(error)} (contractVerification: 'warn' — continuing without strict verification)`,
      );
    }
  };
  return () => {
    verification ??= check().catch((error: unknown) => {
      verification = undefined;
      throw error;
    });
    return verification;
  };
}
