import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateFromSchema } from './cli-generate-files.js';
import { generateFrameCodecsCpp } from './generate-cpp-output.js';

// ubuntu 러너엔 clang++ 이 없고 macOS dev 에선 기본 제공된다 — 둘 중 가용한
// C++ 컴파일러를 쓰고, 어느 쪽도 없으면 이 컴파일 계약 테스트는 건너뛴다.
const cxxCompiler = (): string | null => {
  for (const candidate of ['clang++', 'g++']) {
    if (spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) return candidate;
  }
  return null;
};

// Compile the emitted translation unit: a header-only/new JS identity must not
// stand in for the identity of the actual linked native encoder/decoder.
test('canonical native codec identity matches the exact schema bytes used by JS', async () => {
  const cxx = cxxCompiler();
  if (!cxx) return;
  const directory = mkdtempSync(join(tmpdir(), 'rustra-codec-identity-'));
  try {
    const raw = '{ "packageId": "test.identity", "commands": [] }\n';
    const schema = join(directory, 'schema.json');
    writeFileSync(schema, raw);
    await generateFromSchema(schema, join(directory, 'ts'), directory);
    mkdirSync(join(directory, 'jsi'));
    writeFileSync(join(directory, 'jsi/jsi.h'), '#pragma once\n');
    writeFileSync(
      join(directory, 'main.cpp'),
      `
#include "rustra-generated-codecs.hpp"
#include <iostream>
int main() {
#if defined(RUSTRA_GENERATED_CODEC_CONTRACT_IDENTITY)
  auto hash = rustra::generated::compiled_contract_hash();
  std::cout << (hash ? hash : "missing");
#else
  std::cout << "missing";
#endif
}
`,
    );
    const shim = fileURLToPath(
      new URL(
        '../../../examples/react-native-calculator/modules/rustra-jsi/ios/test-jsi-shim.hpp',
        import.meta.url,
      ),
    );
    const adapter = fileURLToPath(new URL('../../react-native/native/cpp', import.meta.url));
    const compiledIdentity = () => {
      const compiler = spawnSync(
        cxx,
        [
          '-std=c++17',
          '-DRUSTRA_TEST_JSI_SHIM=1',
          '-include',
          shim,
          '-I',
          directory,
          '-I',
          adapter,
          join(directory, 'rustra-generated-codecs.cpp'),
          join(directory, 'main.cpp'),
          '-o',
          join(directory, 'identity'),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(compiler.status, 0, compiler.stderr);
      const run = spawnSync(join(directory, 'identity'), [], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout;
    };
    assert.equal(compiledIdentity(), createHash('sha256').update(raw).digest('hex'));
    // The older renderer call shape cannot recover exact original schema bytes.
    // It must emit unknown identity, not assert a reconstructed contract.
    writeFileSync(
      join(directory, 'rustra-generated-codecs.cpp'),
      generateFrameCodecsCpp({ packageId: 'test.identity', commands: [] }),
    );
    assert.equal(compiledIdentity(), 'missing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
