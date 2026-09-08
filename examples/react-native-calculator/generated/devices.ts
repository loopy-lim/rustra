// ── rustra generated ────────────────────────────────────────
// File:   devices.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts device renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

/** 이 패키지가 선언에 사용한 디바이스 역량 토큰 (Rust 카탈로그 기준). */
export type RustraDeviceCapability = 'camera' | 'bluetooth';

/** deviceDemo 가 전제하는 디바이스 역량 (Rust 선언 기준 — getDeviceStatus(토큰)로 사전 조회). */
export const DEVICE_DEMO_DEVICES: readonly RustraDeviceCapability[] = ['camera', 'bluetooth'];
