// 참고: 섹션 build 검사(section.<target>.build)는 매트릭스 유무와 무관하게 단일 섹션
// config 에서도 항상 수집된다 — 기존에는 없던 검사이므로 checks 소비자는 새 라인을 인지해야 한다.
import { dirname } from 'node:path';
import { cargoPackagesForManifest, findCargoManifest, selectCodegenBinary } from './cargo.js';
import type {
  DoctorCheck,
  DoctorConfig,
  DoctorMatrix,
  DoctorMatrixCell,
  DoctorMatrixRow,
  DoctorRunner,
  DoctorStatus,
} from './doctor-types.js';
import { check, getCargoMetadata, safeResolve } from './doctor-support.js';

/** 매트릭스 행 대상이 되는 호스트 섹션 — 고정 순서(스펙 예시 표와 동일). */
const SECTION_ORDER = ['node', 'bun', 'reactNative', 'tauri'] as const;
export type DoctorSection = (typeof SECTION_ORDER)[number];
type SectionView = {
  rustManifest?: string;
  rustPackage?: string;
  rustLibrary?: string;
  rustBinary?: string;
};

export function doctorHostSections(config: DoctorConfig): DoctorSection[] {
  return SECTION_ORDER.filter((name) => config[name] !== undefined);
}

function sectionView(config: DoctorConfig, target: DoctorSection): SectionView {
  const value = config[target];
  return typeof value === 'object' && value !== null ? (value as SectionView) : {};
}

/** 섹션 매니페스트 결정 — host-entries 와 동일한 폴백(섹션 지정 → 상위 디렉터리 탐색). */
export function resolveSectionManifest(
  configRoot: string,
  config: DoctorConfig,
  target: DoctorSection,
): string | undefined {
  if (target === 'tauri') return undefined;
  const section = sectionView(config, target);
  return safeResolve(configRoot, section.rustManifest) ?? findCargoManifest(configRoot);
}

/** 섹션별 빌드 필수 요소(매니페스트·패키지·라이브러리/바이너리)를 단일 필수 검사로 수집한다. */
function sectionBuildCheck(
  target: Exclude<DoctorSection, 'tauri'>,
  runner: DoctorRunner,
  configRoot: string,
  config: DoctorConfig,
): DoctorCheck {
  const section = sectionView(config, target);
  const manifest = resolveSectionManifest(configRoot, config, target);
  if (!manifest)
    return check(
      `section.${target}.build`,
      'fail',
      true,
      `${target}: could not resolve rustManifest`,
      undefined,
      [`Set ${target}.rustManifest in rustra.json`],
    );
  const metadata = getCargoMetadata(runner, manifest);
  if (!metadata.metadata)
    return check(
      `section.${target}.build`,
      'fail',
      true,
      `${target}: cargo metadata failed for ${manifest}`,
      metadata.error,
      ['Run cargo metadata manually and fix the Cargo manifest'],
    );
  const packages = cargoPackagesForManifest(
    metadata.metadata.packages ?? [],
    manifest,
    section.rustPackage,
  );
  if (packages.length !== 1)
    return check(
      `section.${target}.build`,
      'fail',
      true,
      `${target}: ${packages.length} Cargo packages match (${manifest}); set ${target}.rustPackage`,
    );
  const cargoPackage = packages[0]!;
  // 이름 없는 타깃은 선택 대상이 될 수 없다 — CargoBinaryTarget 계약 정합.
  const targets = (cargoPackage.targets ?? []).filter(
    (candidate): candidate is { name: string; kind?: string[]; crate_types?: string[] } =>
      typeof candidate.name === 'string',
  );
  if (target === 'node') {
    try {
      const binary = selectCodegenBinary(targets, section.rustBinary, [
        cargoPackage.name!,
        'generate',
      ]);
      return check(
        'section.node.build',
        'pass',
        true,
        `node: binary ${binary} from package ${cargoPackage.name}`,
      );
    } catch (error) {
      return check(
        'section.node.build',
        'fail',
        true,
        `node: no runnable binary in package ${cargoPackage.name}`,
        error instanceof Error ? error.message : String(error),
        ['Set node.rustBinary in rustra.json'],
      );
    }
  }
  const crateType = target === 'bun' ? 'cdylib' : 'staticlib';
  const libraries = targets.filter((candidate) => candidate.crate_types?.includes(crateType));
  const selected = section.rustLibrary
    ? libraries.find((candidate) => candidate.name === section.rustLibrary)
    : libraries.length === 1
      ? libraries[0]
      : undefined;
  if (!selected)
    return check(
      `section.${target}.build`,
      'fail',
      true,
      `rustLibrary missing: ${section.rustLibrary ?? `no ${crateType} target in package ${cargoPackage.name}`}`,
      undefined,
      [
        `Add crate-type = ["rlib", "${crateType}"] to package ${cargoPackage.name}, or set ${target}.rustLibrary`,
      ],
    );
  return check(
    `section.${target}.build`,
    'pass',
    true,
    `${target}: ${crateType} ${selected.name} from package ${cargoPackage.name}`,
  );
}

/**
 * 교차 일관성 — 섹션들이 서로 다른 rustManifest/rustPackage 를 가리키면 경고 1줄.
 * 비교 대상은 호스트 섹션뿐이다(codegen 제외 — 스펙 문구 "sections reference" 준수).
 */
function consistencyCheck(configRoot: string, config: DoctorConfig): DoctorCheck | undefined {
  const references = new Map<string, string[]>();
  for (const target of doctorHostSections(config)) {
    const section = sectionView(config, target);
    const manifest = resolveSectionManifest(configRoot, config, target);
    if (!manifest) continue;
    const key = `${manifest}|${section.rustPackage ?? ''}`;
    references.set(key, [...(references.get(key) ?? []), target]);
  }
  if (references.size <= 1) return undefined;
  const detail = [...references.entries()]
    .map(([key, targets]) => `${targets.join(', ')} -> ${key.replace('|', ' package ')}`)
    .join('; ');
  return check(
    'config.rust_consistency',
    'warn',
    false,
    'multiple Rust backends referenced — one project, one contract',
    detail,
    ['Align every host section on the same rustManifest/rustPackage'],
  );
}

/** 호스트 섹션 전체의 검사 수집 — build 검사 + 교차 일관성 검사. */
export function collectSectionChecks(
  runner: DoctorRunner,
  configPath: string,
  config: DoctorConfig,
): DoctorCheck[] {
  const configRoot = dirname(configPath);
  const checks: DoctorCheck[] = [];
  for (const target of doctorHostSections(config)) {
    if (target === 'tauri') continue; // tauri 섹션은 Rust 빌드 설정이 없다 — runtime 열만 평가.
    checks.push(sectionBuildCheck(target, runner, configRoot, config));
  }
  const consistency = consistencyCheck(configRoot, config);
  if (consistency) checks.push(consistency);
  return checks;
}

const CELL_RANK: Record<DoctorMatrixCell, number> = { '—': 0, OK: 1, WARN: 2, FAIL: 3 };
const STATUS_RANK: Record<DoctorStatus, number> = { fail: 3, warn: 2, pass: 1, skip: 0 };

/** 검사 목록 하나를 셀로 요약 — skip(랭크 0)은 평가 대상이 아니고 최악 상태의 summary 를 돌려준다. */
function worstCell(checks: DoctorCheck[]): { cell: DoctorMatrixCell; note?: string } {
  let worst: DoctorCheck | undefined;
  for (const candidate of checks) {
    if (STATUS_RANK[candidate.status] === 0) continue;
    if (!worst || STATUS_RANK[candidate.status] > STATUS_RANK[worst.status]) worst = candidate;
  }
  if (!worst) return { cell: '—' };
  const cell: DoctorMatrixCell =
    worst.status === 'fail' ? 'FAIL' : worst.status === 'warn' ? 'WARN' : 'OK';
  return { cell, note: worst.summary };
}

function runtimeCell(target: DoctorSection, checks: DoctorCheck[]): DoctorCheck[] {
  if (target === 'reactNative') return checks.filter((candidate) => candidate.id.startsWith('rn.'));
  if (target === 'tauri')
    return checks.filter((candidate) => candidate.id === 'tauri.platform_tools');
  return checks.filter((candidate) => candidate.id === 'js.runtime');
}

/**
 * checks(원본)에서 매트릭스(파생 뷰)를 만든다. build FAIL 이면 하류 열은 단락('—') —
 * 못 지은 아티팩트의 계약/런타임은 평가할 수 없다. 섹션이 2개 미만이면 undefined 로
 * 기존 단일 섹션 출력과의 하위호환을 유지한다.
 */
export function buildMatrix(checks: DoctorCheck[], config: DoctorConfig): DoctorMatrix | undefined {
  const sections = doctorHostSections(config);
  if (sections.length < 2) return undefined;
  // contract 열 — 코드젠 계약(매니페스트·제너레이터·스키마 산출물) 검사는 섹션 독립적이라
  // 모든 행이 같은 codegen.* 검사를 공유한다. 섹션별 계약 분리는 요구사항이 아니다.
  const codegenChecks = checks.filter((candidate) => candidate.id.startsWith('codegen.'));
  const rows = sections.map((target) => {
    const build = worstCell(
      checks.filter((candidate) => candidate.id === `section.${target}.build`),
    );
    if (build.cell === 'FAIL')
      return {
        target,
        build: 'FAIL',
        contract: '—',
        runtime: '—',
        notes: build.note ?? '',
      } satisfies DoctorMatrixRow;
    const contract = worstCell(codegenChecks);
    const runtime = worstCell(runtimeCell(target, checks));
    const columns = [
      { cell: build.cell, note: build.note },
      { cell: contract.cell, note: contract.note },
      { cell: runtime.cell, note: runtime.note },
    ];
    const worst = columns
      .filter((column) => column.cell !== '—')
      .reduce((left, right) => (CELL_RANK[right.cell] > CELL_RANK[left.cell] ? right : left));
    // 전부 OK 면 notes 는 '—' — 문제 없는 행은 요약 문장 대신 스펙 예시의 em-dash 를 쓴다.
    const note = worst.cell === 'OK' ? undefined : worst.note;
    return {
      target,
      build: build.cell,
      contract: contract.cell,
      runtime: runtime.cell,
      notes: note ?? '—',
    } satisfies DoctorMatrixRow;
  });
  return {
    rows,
    warnings: checks
      .filter((candidate) => candidate.id === 'config.rust_consistency')
      .map((candidate) => candidate.summary),
  };
}
