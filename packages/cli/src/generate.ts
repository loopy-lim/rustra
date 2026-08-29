/**
 * Public generator facade.
 *
 * The generated wire contract is implemented by focused modules. Keeping the
 * historical import path lets CLI consumers migrate without changing imports.
 */
export * from './generate-surface.js';
export * from './generate-commands.js';
export * from './generate-postcard.js';
export * from './generate-cpp-output.js';
export * from './generate-positional.js';
