/**
 * 빌드타임 parity 캡처 — schema.json 의 SHA-256. cd243cec 단일 소싱 계약상 이
 * 해시는 `rustra_ffi_contract_hash` 및 생성물 `GENERATED_CONTRACT_HASH` 와 같은
 * 원본(schema 직렬화)을 해시하므로, dev 루프는 라이브 엔진 없이도 "reload 전후
 * 계약이 갈라졌는가"를 판정할 수 있다. golden wire 상태는 호스트 훅(A1
 * onReload)이 주입하는 영역이라 여기서는 undefined 다.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from './hash.js';
import type { ParitySnapshot } from './parity-gate.js';

export async function captureSchemaParity(schemaPath: string): Promise<ParitySnapshot> {
  let schema: string;
  try {
    schema = await readFile(schemaPath, 'utf8');
  } catch (error) {
    // ENOENT 를 날로 노출하지 않는다 — parity 게이트는 capture 실패를 fail-closed
    // 불일치로 처리하므로 이 메시지가 "[dev] reload rejected" 사유로 그대로 보인다.
    // cli-generate-files.ts 의 schema ENOENT 랩과 같은 모양을 유지한다.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `Schema file not found: ${resolve(schemaPath)} — the codegen stage did not produce it. ` +
          `Check codegen.schema in rustra.json, then re-run "rustra codegen --config <config>".`,
        { cause: error },
      );
    }
    throw error;
  }
  return { contractHash: sha256(schema) };
}
