---
'@rustra/types': minor
---

RustraNative shrinks to the supported surface: `invokeMsgpack`, `invokeBincode`,
`invokePostcard`, `invokeRkyv`, `invokeHybrid`, and `invokeRaw` are removed.
The generic transport (`invoke`, `invokeRkyvV2`) and typed fast paths
(`invokeTyped*`, `getCodecCapabilities`) are unchanged. Apps that compared
wire formats should use `invokeRkyvV2` codecs or the generic `invoke`.
