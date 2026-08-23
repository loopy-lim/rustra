/**
 * Auth 예제 Node 앱 — 세션/토큰 + capability 게이트 end-to-end 데모.
 *
 * Rust 를 `--serve` 라인 데몬으로 띄운다 — 세션 상태가 프로세스에 유지되므로
 * 시나리오(signIn → grant → adminStats → signOut → denied)가 성립한다.
 *
 * 실행: cargo build -p rustra-auth-example && \
 *       bunx tsc -p examples/auth/tsconfig.json && \
 *       node dist-ts/examples/auth/apps/node-app.js
 */
import { spawn } from 'node:child_process';
import { signIn, signOut, grant, adminStats } from '../generated/commands.js';
import { configure, RustraCommandError } from '@rustra/types';
import { createNodeEngine } from '@rustra/node';

const RUST_BIN = 'target/debug/rustra-auth-invoke';

// ── 라인 데몬 프로토콜 ─────────────────────────────────────────
const child = spawn(RUST_BIN, ['--serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

let buffer = '';
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line) as {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string } | string;
    };
    const waiter = pending.get(response.id);
    if (!waiter) continue;
    pending.delete(response.id);
    if (response.ok) {
      waiter.resolve(response.result);
    } else {
      // 구조화된 에러({code, message})면 코드를 보존해 전달 — 어댑터의
      // RustraCommandError 복원 경로가 활성화된다.
      const e = response.error;
      if (typeof e === 'object' && e !== null) {
        const err = new Error(e.message) as Error & { code: string };
        err.code = e.code;
        waiter.reject(err);
      } else {
        waiter.reject(new Error(e ?? 'invoke failed'));
      }
    }
  }
});

function invokeRust(command: string, args?: unknown): Promise<unknown> {
  const id = nextId++;
  const payload = JSON.stringify({ id, command, args }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload);
  });
}

const engine = createNodeEngine({
  invoke(command, args) {
    return invokeRust(command, args);
  },
});
configure(engine);

// ── 시나리오 ───────────────────────────────────────────────────

// 1. 일반 사용자 — capability 부여 거부
const user = await signIn({ username: 'alice', password: 'password123' });
assertRole(user.role, 'user');
const userGrant = await grant({ token: user.token, capability: 'admin.stats' });
if (userGrant.granted) throw new Error('user should not be granted admin.stats');
console.log('[auth] user grant admin.stats → denied (role=user)');

// 2. admin — grant 후 조회 성공
const admin = await signIn({ username: 'root', password: 'hunter2' });
assertRole(admin.role, 'admin');
const adminGrant = await grant({ token: admin.token, capability: 'admin.stats' });
if (!adminGrant.granted) throw new Error('admin grant should succeed');
const stats = await adminStats({ token: admin.token });
console.log(`[auth] adminStats: sessions=${stats.sessions} uptime=${stats.uptimeMs}ms`);

// 3. signOut 후 재시도 → denied
await signOut({ token: admin.token });
await expectCapabilityDenied(adminStats({ token: admin.token }), 'after signOut');

console.log('[auth] PASS — capability gate verified (user denied / admin allowed / revoked)');
child.kill();
process.exit(0);

function assertRole(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`role expected ${expected}, got ${actual}`);
}

async function expectCapabilityDenied(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    throw new Error(`${label}: expected capability.denied but succeeded`);
  } catch (e) {
    // RustraCommandError 면 code 필드로 판별 (instanceof 대신 duck-typing —
    // 모듈 인스턴스 차이에도 견고).
    const err = e as { code?: string; message?: string };
    if (typeof err.code === 'string') {
      if (err.code !== 'capability.denied') {
        throw new Error(`${label}: wrong code ${err.code}`);
      }
      console.log(`[auth] ${label}: capability.denied (as expected)`);
      return;
    }
    const msg = err.message ?? String(e);
    if (!msg.includes('capability.denied')) throw e;
    console.log(`[auth] ${label}: capability.denied (as expected)`);
  }
}
