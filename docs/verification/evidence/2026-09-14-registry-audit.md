# Release registry audit

- Fetched at: `2026-09-14T06:23:25.293Z`
- Candidate: `b1ed9aa422fb4e627131f02f67de9f50bdbfedf7` (dirty)

A mixed version matrix and a registry source older than the candidate are valid audit results. Only query, archive, checksum, or local artifact failures make the audit operationally unsuccessful.

## npm packages

| Package              | Workspace | Exact  | Latest | Publication | Registry source                          | Relation  | Dist tarball                                                             |
| -------------------- | --------- | ------ | ------ | ----------- | ---------------------------------------- | --------- | ------------------------------------------------------------------------ |
| @rustra/bun          | 0.10.0    | 0.10.0 | 0.10.0 | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/bun/-/bun-0.10.0.tgz                  |
| @rustra/cli          | 0.10.0    | 0.10.0 | 0.10.0 | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/cli/-/cli-0.10.0.tgz                  |
| @rustra/devtools     | 0.7.0     | 0.7.0  | 0.7.0  | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/devtools/-/devtools-0.7.0.tgz         |
| @rustra/node         | 0.10.0    | 0.10.0 | 0.10.0 | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/node/-/node-0.10.0.tgz                |
| @rustra/react        | 0.8.0     | 0.8.0  | 0.8.0  | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/react/-/react-0.8.0.tgz               |
| @rustra/react-native | 0.9.0     | 0.9.0  | 0.9.0  | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/react-native/-/react-native-0.9.0.tgz |
| @rustra/tauri        | 0.9.0     | 0.9.0  | 0.9.0  | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/tauri/-/tauri-0.9.0.tgz               |
| @rustra/testing      | 0.7.0     | 0.7.0  | 0.7.0  | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/testing/-/testing-0.7.0.tgz           |
| @rustra/types        | 0.10.0    | 0.10.0 | 0.10.0 | published   | 30c73bd66159f4c777054527236573559c106c98 | different | https://registry.npmjs.org/@rustra/types/-/types-0.10.0.tgz              |

## crates.io crates

| Crate         | Workspace | Exact  | Yanked | Latest | Publication | Archive SHA-256                                                  | Verified | VCS source                               | Dirty | Relation  |
| ------------- | --------- | ------ | ------ | ------ | ----------- | ---------------------------------------------------------------- | -------- | ---------------------------------------- | ----- | --------- |
| rustra        | 0.10.0    | 0.10.0 | false  | 0.10.0 | published   | 88d85b094de6ab1b5dc4224d8ecb3541ead940e256633617fa488d727f3d058b | true     | 30c73bd66159f4c777054527236573559c106c98 | false | different |
| rustra-macros | 0.10.0    | 0.10.0 | false  | 0.10.0 | published   | bd9092002ccc708de179b5a59957b39e29ab455c90cfb96b3b43e585e5b672a1 | true     | 30c73bd66159f4c777054527236573559c106c98 | false | different |
| rustra-naming | 0.10.0    | 0.10.0 | false  | 0.10.0 | published   | 679462f66ca48f64c0e5a6df85212702fd84db01bfa35541c608e07dc67b8f80 | true     | 30c73bd66159f4c777054527236573559c106c98 | false | different |

## Local artifact evidence

These hashes identify local generated/native files only. They do not prove registry publication or physical-device runtime.

| Path                                                                   |  Bytes | SHA-256                                                          |
| ---------------------------------------------------------------------- | -----: | ---------------------------------------------------------------- |
| packages/react-native/native/cpp/RustraJSIBridge.cpp                   | 112616 | 66c42498759b259412311ab423b69c9884fea710724704f1d90b09c9ab10a3be |
| packages/react-native/native/android/rustra-jsi-jni.cpp                |   4249 | e0e335e2e05745e5af7eadf5c53b133bfa32154f3429092c02e8c6b143ea0189 |
| packages/react-native/native/ios/RustraJSIModule.mm                    |   3813 | 8ce2ae0223be65ea09f543924a9e5ec01de992609bf03e2da802bffe96155a70 |
| examples/react-native-bare-calculator/generated/.rustra-generated.json |   3821 | ff8532b67899dc6c95a172ec31453330fcfa7bf710672e7eeafef8160f6f830f |

## Operational errors

None.
