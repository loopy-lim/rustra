import { execFileSync } from 'node:child_process';

const output = execFileSync('bunx', ['--bun', 'react-native', 'config'], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
});
const config = JSON.parse(output);
const dependency = config.dependencies?.['@rustra/generated-react-native'];
if (!dependency?.platforms?.ios?.podspecPath || !dependency?.platforms?.android?.sourceDir) {
  throw new Error('Rustra generated module is not autolinked on both iOS and Android');
}
if (config.dependencies?.expo) {
  throw new Error('Bare React Native fixture unexpectedly depends on Expo');
}
console.log('bare React Native autolinking: iOS + Android PASS');
