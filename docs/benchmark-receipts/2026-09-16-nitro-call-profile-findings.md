# Task 2 — baseline call-profile findings

Read-only audit of eight completed public-bindSync/Nitro workload captures. No source changes, tests, builds, devices, or subagents. The profiles support trying the generic immutable fixed-property context for small outputs; they do **not** support it as a solution to tree serialization or resident DFS cost.

## Evidence and interpretation boundary

Each directory below is under `/private/tmp/` and contains `sample.txt` and `receipt.json`. All receipts report complete. Recomputed sample SHA-256 matches every receipt; all eight receipts identify the same native binary SHA-256 `5975967fc1dc951c0280a2ade23010b5e8a1e3421ab98520bbb92811992511f1`. Each sample starts after its receipt's activeAt and finishes before finishedAt. Requested workload duration is 15 s and CPU capture is 10 s. Source/bundle identities remain in those receipts. These are Simulator Release Hermes diagnostics with Nitro/nitrogen 0.37.1.

Only the `com.facebook.react.runtime.JavaScript` subtree is used. Main/UI/Hades/worker thread totals are excluded. `L` means a one-based line in that directory's sample.txt. Counts are inclusive at the specified branch; child counts are examples within their parent, never additional cost. Sibling call-site counts can be summed; matching symbols at different depths are not blindly summed. No cross-process count difference or within-process percentage is throughput, causal time subtraction, or a promised gain.

| Case | Rustra directory / JS thread anchor | Nitro directory / JS thread anchor |
| --- | --- | --- |
| pair | rustra-call-profile-pair-rustra-3; L56, 8162 samples | rustra-call-profile-4-nitro; L56, 8162 |
| string | rustra-call-profile-5-rustra; L56, 8110 | rustra-call-profile-6-nitro; L62, 8124 |
| balanced8191/echo | rustra-call-profile-7-rustra; L56, 8015 | rustra-call-profile-8-nitro; L56, 8057 |
| balanced8191/resident-dfs | rustra-call-profile-9-rustra; L56, 8049 | rustra-call-profile-10-nitro; L56, 8280 |

## Pair: fixed output names are a concrete small-call candidate

Rustra sibling bound-function branches: result decode L88 **1512 (18.52%)**; frame FFI L454 **422 (5.17%)**. The decode branch contains two fixed-name construction sites L238 **252** and L301 **223**, totaling **475 (5.82% of its thread; 31.42% of decode)**. Property sets at decode sites L89 **342** and L164 **333** are separate sibling sites inside decode and remain necessary. The generated function creates `name` and `value` once per result; positional input already avoids property-name creation.

Precision: 475 is the inclusive count at the two decode call sites, including dispatch/stub/helper work. It is not the exact total for the Hermes createPropNameIDFromAscii symbol. A topmost-symbol aggregation in the JS subtree gives **457** for that symbol (including a separate 8-sample site at L440). Do not describe 475 as 475 samples exclusively inside that runtime function.

Nitro has a result-converter branch L89 **1582 (19.38%)** and input-converter branch L397 **843 (10.33%)**, siblings within the hybrid call. Result `toJSI` sites L90 **426** and L170 **389** are property-set work; L239 **211** includes string construction. Cache-lookup sites L325 **108**, L346 **94**, L458 **119**, L479 **113** show the fixed-name cache still has runtime/string lookup overhead. Actual `PropNameIDCache::get` topmost-frame aggregate is 378 within this process, not an amount to subtract from Rustra's 475.

Classification: direct relevance to the per-bound-function finite-name candidate; preserve fresh result objects and property-set semantics. The profile does not establish whether replacing name construction with context capture/access wins after its own costs.

## String: conversion costs remain after the one fixed name

Rustra bound-function siblings: decode L88 **1604 (19.78%)**, positional input encode L379 **1084 (13.37%)**, FFI L468 **543 (6.70%)**.

Within decode, L89 **910** is the output string-creation site (its child L90 is createStringFromUtf8, **811**); L189 **347** is the result property-set site; L264 **199 (2.45% of thread)** is the fixed output-name construction site. Within input encode, L380 **848** is encode_pos_by_id and L381 **826** is utf8FromStringView, with UTF16→UTF8 conversion descendants at L382–384. These nested counts must not be added to 1084.

Nitro callMethod siblings include output conversion L95 **1659 (20.42%)** and input conversion L330 **1536 (18.91%)**. Its result string site L96 **1053** includes createStringFromUtf8 L97 **969**; input L331 **1005** includes utf8FromStringView L332 **973**. Fixed-name lookup appears at output L289 **88** and input L424 (see its child cache call L425 **53**). These counts are measured in a separate process and do not rank conversion efficiency.

Classification: the generic context addresses the repeated one-name construction but leaves Unicode conversion, C++ string allocation/growth, JS string creation, output-object/property work and wire work. Do not infer that caching one name closes the string parity gap.

## Balanced 8191-node echo: serialization and materialization dominate

Rustra bound-function siblings partition almost all JS-thread samples: decode L88 **3340 (41.67%)**, whole-object encode L1876 **2881 (35.95%)**, FFI L2750 **1717 (21.42%)**. These total 7938/8015; do not add their children again.

Representative decode siblings:

- L89 **343**: dynamic map-key PropNameID-from-UTF8 site; the actual runtime-function child at L90 has **148**, with more sibling instruction locations. Across the whole JS subtree, topmost createPropNameIDFromUtf8 frames total **326** (L90:148, L157:134, L174:23, L181:10, L183:6, L188:2, L1855:3).
- L191 **343**: map string-value property set, with setProperty child L192 **314**.
- L286 **267** and L1341 **142**: object construction; L287 **142** includes allocation/young-generation collection. This GC is on the JS thread and inside the parent; background Hades counts remain excluded.
- L673 **191**, L867 **163**, L1528 **120**: string construction sites.
- L438 **231**, L595 **197**, L813 **169**, L962 **157**, L1037 **156**: named-property sets; some symbols are deduplicated, but their child frames identify setPropertyValue.
- L1093 **153** and L1479 **140**: array element writes; L1174 **145**: array construction.

Encode site L1878 **591** contains dynamic property-name enumeration (getPropertyNames L1879 **317**, plus enumeration array work L1880 **249**). Site L2082 **252** contains dynamic string-key getProperty L2083 **114**. These are required map enumeration/getter/snapshot work, not finite schema-name creation.

Only **one** sampled createPropNameIDFromAscii frame appears in the Rustra tree JS subtree (L1867 **1**, 0.01%). That does not mean zero real creation calls: current generated input/output codec resolves its seven finite names outside the node loops, so this cost is amortized across 8191 nodes. Retaining those names across calls has little supporting profile mass here.

Within native FFI, the generated frame-handler's sibling sites are deserialize-oriented L2754 **980** (Vec deserialization L2755 **926**, nested BTreeMap/string allocation at L2757–2821), drop/cleanup L2924 **517**, and serialization L3029 **149**. They are children of the 1717 FFI branch and cannot be added to it. The remaining cost includes both sides of wire conversion and native allocation/cleanup.

Nitro callMethod siblings: fromJSI L89 **4032 (50.04%)**, toJSI L1333 **3283 (40.75%)**, vector copy L2928 **269**, output/input vector destruction L3012 **247** and L3061 **216**. Its input node conversion contains unordered_map conversion L93 **624** and property enumeration L94 **307**; its output remains per-node object/string/property/array creation, with toJSI child L1334 **3117**. Nitro's existing name cache has measurable accesses but cannot remove these dynamic/value costs.

Classification: fixed-name candidate has low direct relevance to this large case. Further generic tree investigation should focus on dynamic map enumeration/lookup, JS object and string construction/property writes, and Rust wire deserialization/allocation/cleanup while preserving getter order, canonical bytes and fresh ownership. No raw borrowed-tree/retained-output shortcut is justified by this evidence.

## Resident DFS: application search dominates both frameworks

Rustra FFI branch L88 **7855/8049 (97.59%)** contains resident handler L93 **7835 (97.34%)**, which contains search L94 **7799** plus smaller search instruction/call sites. The L94 search frame is a leaf representing instruction ranges; it is not another independently additive bucket. Result decode is sibling L148 **61 (0.76%)**. A search growth site L95 **28** contains Vec grow_one/realloc, not a major share in this capture. Names are minor: actual createPropNameIDFromAscii frames total 25, all inside the already-small conversion work.

Nitro resident method L90 **8093/8280 (97.74%)** is inside callMethod L89 **8093**. Its children include search L91 **4167**, search call site L92 **2119**, and a deduplicated symbol L109 **1802**; these and small residual children sum to the same method branch, not extra time. Without disassembly the deduplicated symbol must not be assigned to a particular loop operation. Output conversion is sibling L120 **46 (0.56%)**.

Classification: both profiles are native search dominated. Property caching is not a substantive DFS optimization based on these samples. Preserve the same traversal/index/visited semantics; any future change must be a separately justified algorithm/data-layout experiment applied under the original comparison contract. Cross-process absolute counts do not establish relative Rust versus C++ DFS efficiency.

## Decision

Continue the bounded generic fixed-schema-name experiment for small calls, with the lifetime design and deterministic gates in the ownership design documented in ../research/2026-09-16-nitro-call-profile.md. Treat string, tree and resident DFS as distinct remaining cost classes. Keep every original parity lane and five-process CI acceptance criterion; these captures are diagnosis only, not an updated performance result or permission to drop difficult cases.
