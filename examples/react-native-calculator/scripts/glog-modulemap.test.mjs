import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import plugin from '../plugins/with-glog-textual-headers.cjs';

test('Expo Podfile hook is repeatable and rejects an unknown template', () => {
  const original = 'target "app" do\n  post_install do |installer|\n    react_native_post_install(installer)\n  end\nend\n';
  const patched = plugin.configurePodfile(original);
  expect(patched).toContain('    rustra_fix_glog_modulemap(installer)');
  expect(patched).toContain('    react_native_post_install(installer)');
  expect(plugin.configurePodfile(patched)).toBe(patched);
  expect(() => plugin.configurePodfile('target "app" do\nend')).toThrow('post_install');
});

test('pod hook preserves module exports, skips other versions, and requires both real headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra glog '));
  const mapPath = join(root, 'Target Support Files/glog/glog.modulemap');
  const headers = join(root, 'Headers/Public/glog/glog');
  const original = 'module glog {\n  umbrella header "glog-umbrella.h"\n  export *\n  module * { export * }\n}\n';
  mkdirSync(join(root, 'Target Support Files/glog'), { recursive: true });
  mkdirSync(headers, { recursive: true });
  writeFileSync(mapPath, original);
  const ruby = `require 'pathname'
require ARGV[0]
pod = Struct.new(:name, :root_spec).new('glog', Struct.new(:version).new(ARGV[2]))
installer = Struct.new(:pod_targets, :sandbox).new([pod], Struct.new(:root).new(Pathname.new(ARGV[1])))
2.times { rustra_fix_glog_modulemap(installer) }
`;
  const run = (version) => spawnSync('ruby', ['-e', ruby,
    fileURLToPath(new URL('./fix-glog-modulemap.rb', import.meta.url)), root, version], { encoding: 'utf8' });
  try {
    expect(run('0.4.0').status).toBe(0);
    expect(readFileSync(mapPath, 'utf8')).toBe(original);
    expect(run('0.3.5').stderr).toContain('Missing glog header');
    expect(readFileSync(mapPath, 'utf8')).toBe(original);
    for (const name of ['log_severity.h', 'vlog_is_on.h']) writeFileSync(join(headers, name), '// fixture');
    const result = run('0.3.5');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const patched = readFileSync(mapPath, 'utf8');
    expect(patched.match(/textual header/g)).toHaveLength(2);
    expect(patched).toContain('module * { export * }');
    expect(patched).toContain(JSON.stringify(join(headers, 'log_severity.h')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
