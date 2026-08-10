import { defineConfig } from '@lynx-js/rspeedy';
import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';

export default defineConfig({
  source: {
    entry: { index: './src/index.tsx' },
  },
  plugins: [pluginReactLynx()],
  tools: {
    rspack: {
      resolve: {
        // generated/*.ts 파일들이 TS NodeNext 규약으로 '.js' 확장자 import를 쓴다.
        // bundler가 '.js' import를 '.ts'로 해석하도록 매핑.
        extensionAlias: {
          '.js': ['.ts', '.tsx', '.js'],
        },
      },
    },
  },
});
