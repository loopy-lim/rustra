import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FIXTURES,
  makeTree,
} from '../../examples/react-native-calculator/src/nitro-parity/fixtures';

const directory = resolve(process.argv[2]);
mkdirSync(directory, { recursive: true });
for (const [shape, count] of FIXTURES) {
  const tree = makeTree(shape, count);
  // std::quoted is deliberately kept from the original host-only loader. Reject
  // strings requiring JSON control/unicode escaping instead of misdecoding them.
  for (const node of tree.nodes) {
    for (const text of [
      node.name,
      node.tag,
      node.note ?? '',
      ...Object.keys(node.metadata),
      ...Object.values(node.metadata),
    ]) {
      if (!/^[\x20-\x7e]*$/.test(text))
        throw new Error('host loader requires printable ASCII strings');
    }
  }
  writeFileSync(resolve(directory, `${shape}${count}.json`), JSON.stringify(tree) + '\n');
}
writeFileSync(
  resolve(directory, 'fixture-order.json'),
  JSON.stringify(FIXTURES.map(([shape, count]) => `${shape}${count}`)) + '\n',
);
