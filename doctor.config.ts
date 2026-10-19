// react-doctor 진단 예외 — 스캔 범위·나머지 규칙은 기본값 그대로 두고, 증거 번들의
// 진단만 타깃으로 떨군다(ignore.overrides). evidence 파일은 매니페스트가 sha256 으로
// pin 한 보존 아티팩트(당시 원본 소스·로그)라 앱 소스가 아니고, 파일을 고치면 증거
// 무결성이 깨져 줄 단위 억제 주입도 불가능하다. defineConfig 래퍼여야 예외가 적용된다.
import { defineConfig } from 'react-doctor/api';

export default defineConfig({
  ignore: {
    overrides: [
      {
        files: ['docs/verification/evidence/**'],
      },
    ],
  },
});
