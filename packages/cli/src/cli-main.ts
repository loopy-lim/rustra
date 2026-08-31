import { printHelp } from './cli-help.js';
import { cliVersion, CLI_COMMANDS } from './cli-runtime.js';
import { runCodegen } from './cli-codegen.js';
import { runGenerate, runWatch } from './cli-generate.js';
import { runInit } from './cli-init.js';
import { runDiff } from './cli-diff.js';
import { runDoctor } from './cli-doctor.js';
import { runInspect } from './cli-inspect.js';
import { closestMatch } from './cli-suggest.js';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(cliVersion);
    return;
  }
  if (!args[0] || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  const command = args[0];
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    printHelp(command);
    return;
  }
  if (command === 'generate') {
    if (rest.includes('--watch')) {
      await runWatch(rest.filter((argument) => argument !== '--watch'));
      return;
    }
    await runGenerate(rest);
    return;
  }
  if (command === 'codegen') {
    await runCodegen(rest);
    return;
  }
  if (command === 'init') {
    await runInit(rest);
    return;
  }
  if (command === 'diff') {
    await runDiff(rest);
    return;
  }
  if (command === 'doctor') {
    await runDoctor(rest);
    return;
  }
  if (command === 'inspect') {
    await runInspect(rest);
    return;
  }
  if (command === 'dev') {
    const { runDev } = await import('./dev.js');
    await runDev(rest);
    return;
  }
  const suggestion = closestMatch(command, CLI_COMMANDS);
  console.error(`Unknown command: ${command}`);
  console.error(`Available commands: ${CLI_COMMANDS.join(', ')}`);
  if (suggestion) console.error(`Did you mean "rustra ${suggestion}"?`);
  console.error('Run "rustra --help" for usage information.');
  process.exitCode = 1;
}
