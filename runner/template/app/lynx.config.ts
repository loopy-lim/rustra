import { defineConfig } from '@lynx-js/rspeedy';
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';

// rspeedy 설정 — 스파이크(examples/lynx-tauri-spike/lynx.config.ts) 와 동일.
// generated/*.ts 가 TS NodeNext 규약의 '.js' import 를 쓰므로 bundler 가 '.js'→'.ts' 로 해석.
export default defineConfig({
  source: {
    entry: { index: './src/index.tsx' },
  },
  plugins: [pluginReactLynx()],
  tools: {
    rspack: {
      resolve: {
        extensionAlias: {
          '.js': ['.ts', '.tsx', '.js'],
        },
      },
    },
  },
});
