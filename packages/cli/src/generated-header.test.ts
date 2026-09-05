import { describe, expect, test } from 'bun:test';
import { generatedFileHeader, headerFor } from './generated-header.js';

describe('generatedFileHeader', () => {
  test('deterministic — same inputs, same bytes', () => {
    const a = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    const b = generatedFileHeader('types.ts', 'rust-probe schema → ts renderer');
    expect(a).toBe(b);
  });

  test('contains source, regen command, do-not-edit, and stage', () => {
    const header = generatedFileHeader('rkyv-codecs.ts', 'rust-probe schema → ts renderer');
    expect(header).toContain('// ── rustra generated');
    expect(header).toContain('Source: schema.json');
    expect(header).toContain('Regen:  rustra codegen --config rustra.json');
    expect(header).toContain('DO NOT EDIT');
    expect(header).toContain('Stage:  rust-probe schema → ts renderer');
  });

  test('ends with a single blank line — content follows directly', () => {
    const header = generatedFileHeader('types.ts', 'x');
    expect(header.endsWith('\n\n')).toBe(true);
    expect(header.endsWith('\n\n\n')).toBe(false);
  });
});

describe('header syntax per file type — CI01 root cause', () => {
  // JSON은 RFC 8259상 주석 문법이 없다. 무조건 // 헤더를 찍으면 react-native
  // config JSON 파싱이 죽는다(typescript 잡 test:autolink 재현). 출처 추적은
  // .rustra-generated.json 매니페스트가 담당한다 — 헤더를 넣지 않는다.
  test('json 파일은 주석 문법이 없어 헤더를 찍지 않는다', () => {
    expect(generatedFileHeader('package.json', 'test', '"name": "x"\n')).toBe('"name": "x"\n');
  });

  // shebang은 첫 바이트여야만 커널/exec가 해석한다 — 헤더를 앞에 붙이면 스크립트가 깨진다.
  test('shell은 shebang 뒤에 # 주석 헤더를 부착한다', () => {
    const out = generatedFileHeader('build-rust-android.sh', 'test', '#!/bin/sh\nset -e\n');
    expect(out.startsWith('#!/bin/sh')).toBe(true);
    expect(out).toContain('# ── rustra generated');
    expect(out).toContain('# Regen:  rustra codegen --config rustra.json');
  });

  test('shebang 없는 shell도 # 헤더로 시작한다', () => {
    const out = generatedFileHeader('run.sh', 'test', 'set -e\n');
    expect(out.startsWith('# ── rustra generated')).toBe(true);
    expect(out).toContain('set -e');
  });

  test('ruby podspec은 # 주석 헤더를 부착한다', () => {
    const out = generatedFileHeader('RustraBridge.podspec', 'test', 'Pod::Spec.new do |s|\n');
    expect(out.startsWith('# ── rustra generated')).toBe(true);
    expect(out).toContain('# DO NOT EDIT');
  });

  // XML 주석은 `--`를 포함할 수 없다(xmllint: Double hyphen within comment) —
  // 헤더 본문의 --config 플래그도 XML 변형에서는 다시 표현한다.
  test('xml은 <!-- --> 헤더를 부착하고 주석 본문에 -- 를 쓰지 않는다', () => {
    const out = generatedFileHeader('AndroidManifest.xml', 'test', '<manifest>\n');
    expect(out.startsWith('<!--')).toBe(true);
    expect(out).toContain('rustra generated');
    for (const line of out.split('\n')) {
      const body = line.replace(/^\s*<!--/, '').replace(/-->.*$/, '');
      expect(body.includes('--')).toBe(false);
    }
  });

  // 실측: cmake -P 는 // 라인을 "Parse error. Expected a command name" 으로 죽인다 —
  // CMake의 줄 주석은 # 이다.
  test('CMakeLists는 # 주석 헤더를 부착한다', () => {
    const out = generatedFileHeader(
      'CMakeLists.txt',
      'test',
      'cmake_minimum_required(VERSION 3.22)\n',
    );
    expect(out.startsWith('# ── rustra generated')).toBe(true);
  });

  test('gradle/kotlin/ts/cpp는 // 헤더를 유지한다', () => {
    expect(
      generatedFileHeader('build.gradle', 'test', 'plugins {}\n').startsWith('// ── rustra'),
    ).toBe(true);
    expect(
      generatedFileHeader('RustraBridgeModule.kt', 'test', 'class X\n').startsWith('// ── rustra'),
    ).toBe(true);
    expect(generatedFileHeader('types.ts', 'test', 'export {}\n').startsWith('// ── rustra')).toBe(
      true,
    );
    expect(
      generatedFileHeader('RustraBridge.cpp', 'test', '#include "x"\n').startsWith('// ── rustra'),
    ).toBe(true);
    expect(
      generatedFileHeader('RustraBridgeModule.mm', 'test', '#include "x"\n').startsWith(
        '// ── rustra',
      ),
    ).toBe(true);
  });

  test('확장자 없는/미지 파일은 // 기본값을 유지한다 — 기존 호출부 호환', () => {
    expect(generatedFileHeader('types.ts', 'x').startsWith('// ── rustra generated')).toBe(true);
  });

  test('헤더 파싱 헬퍼 headerFor가 스트립을 대칭 달성한다', () => {
    const content = 'x\n';
    const wrapped = generatedFileHeader('a.kt', 't', content);
    expect(headerFor(wrapped, 'a.kt')).toBe(content);
    const sh = generatedFileHeader('a.sh', 't', '#!/bin/sh\nset -e\n');
    expect(headerFor(sh, 'a.sh')).toBe('#!/bin/sh\nset -e\n');
    const xml = generatedFileHeader('a.xml', 't', '<manifest>\n');
    expect(headerFor(xml, 'a.xml')).toBe('<manifest>\n');
    const json = generatedFileHeader('a.json', 't', '{"k": 1}\n');
    expect(headerFor(json, 'a.json')).toBe('{"k": 1}\n');
  });
});
