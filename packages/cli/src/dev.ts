/**
 * `rustra dev` — Rust 소스 감시 + dual-path codegen 자동 루프.
 *
 * 기존 `rustra generate --watch` 는 schema.json 변경만 감시하는데 schema.json 은
 * Rust bin 을 실행해야 갱신된다. `rustra dev` 는 backend/src 변경을 감지해
 * (1) Rust bin → types/commands/contract/schema, (2) TS CLI → rkyv-codecs/registry
 * 를 순서대로 재실행한다 (dual-path — runner/template/codegen.sh 와 동일 계약).
 */

export interface DevOptions {
  backendDir: string;
  appDir: string;
}

export function parseDevArgs(args: string[]): DevOptions {
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    backendDir: get('backend') ?? 'backend',
    appDir: get('app') ?? 'app',
  };
}

export interface PipelinePlan {
  rustBin: boolean;
  tsCli: boolean;
}

export function planPipeline(dirty: {
  rustNewerThanSchema: boolean;
  codecsStaleAgainstSchema: boolean;
}): PipelinePlan {
  return {
    // rust 소스가 새면 schema 재생성 필요 → schema 가 바뀌면 ts cli 재생성 필요
    rustBin: dirty.rustNewerThanSchema,
    tsCli: dirty.rustNewerThanSchema || dirty.codecsStaleAgainstSchema,
  };
}
