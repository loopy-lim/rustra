import type { PackageSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { collectAllDefinitions } from './generate-postcard-ir.js';
import { commandCodecSupported, complexCodecSupported } from './generate-postcard-support.js';

export function generateRkyvRegistryTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const included: { name: string; codec: string; route: 'postcard' | 'complex' }[] = [];
  const excluded: string[] = [];
  for (const command of schema.commands) {
    if (commandCodecSupported(command, definitions)) {
      included.push({
        name: command.name,
        codec: `${commandFunctionName(command.name)}Codec`,
        route: 'postcard',
      });
    } else if (complexCodecSupported(command, definitions)) {
      included.push({
        name: command.name,
        codec: `${commandFunctionName(command.name)}ComplexCodec`,
        route: 'complex',
      });
    } else {
      excluded.push(command.name);
      console.warn(
        `[rustra] WARN: command '${command.name}' has a schema unsupported by both the postcard and complex codecs; excluding from rkyv V2 registry — the engine will route it via Tier 3 JSON fallback.`,
      );
    }
  }
  const entries = included
    .map(({ name, codec, route }) => `  // route: ${route}\n  ['${name}', ${codec}]`)
    .join(',\n');
  const imports = included.map(({ codec }) => codec).join(', ');
  const header =
    included.length === schema.commands.length
      ? ''
      : `// ${excluded.length} command(s) excluded — unsupported postcard field types (Tier 3 fallback): ${excluded.join(', ')}\n`;
  return `${header}import { ${imports} } from './rkyv-codecs.js';\n\nexport const rkyvV2Registry = new Map<string, import('@rustra/types').RkyvV2Codec<any, any>>([\n${entries},\n]);\n`;
}
