module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: './ios/RustraJSI.podspec',
      },
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.rustrajsi.RustraJSIPackage;',
        packageInstance: 'new RustraJSIPackage()',
      },
    },
  },
};
