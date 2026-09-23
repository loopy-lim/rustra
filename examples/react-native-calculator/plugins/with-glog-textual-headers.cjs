const { withPodfile } = require('expo/config-plugins');

// glog 0.3.5 includes these headers inside a namespace. Clang must not turn
// those includes into submodule imports when Nitro exposes C++ to Swift.
function configurePodfile(contents) {
  const hook = "require_relative '../scripts/fix-glog-modulemap'";
  if (contents.includes(hook)) return contents;
  const anchor = /^([ \t]*)post_install do \|installer\|[ \t]*$/m;
  if (!anchor.test(contents)) {
    throw new Error('Cannot configure glog: expected the Expo Podfile post_install hook.');
  }
  return contents.replace(anchor, (line, indent) =>
    `${line}\n${indent}  ${hook}\n${indent}  rustra_fix_glog_modulemap(installer)`,
  );
}

module.exports = (config) => withPodfile(config, (mod) => {
  mod.modResults.contents = configurePodfile(mod.modResults.contents);
  return mod;
});
module.exports.configurePodfile = configurePodfile;
