module.exports = {
  dependency: {
    platforms: {
      ios: { podspecPath: './RustraWasmSpike.podspec' },
      android: {
        sourceDir: './android',
        packageImportPath:
          'import dev.rustra.wasmspike.RustraWasmSpikePackage;',
        packageInstance: 'new RustraWasmSpikePackage()',
      },
    },
  },
};
