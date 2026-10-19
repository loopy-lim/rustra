// react-doctor CI 게이트 표면 조정 — 스캔 범위·내장 제외·규칙 활성은 기본값 그대로 둔다.
// docs/verification/evidence 의 보존 아티팩트(sha256 핀, 당시 원본 소스)는 앱 소스가
// 아니므로 deslop/unused-file 이 docs 산물을 쳐내지 않게 한다. 진단은 로컬·PR 코멘트·
// 점수 표면에 그대로 남는다. ignore 키는 내장 제외셋을 대체하므로 쓰지 않는다.
// docs/verification/evidence/**/* 를 훑는 사유: scriptc sanitizer probe 원본 보존.
import { defineConfig } from 'react-doctor/api';

export default defineConfig({
  surfaces: {
    ciFailure: {
      excludeRules: ['deslop/unused-file'],
    },
  },
});
