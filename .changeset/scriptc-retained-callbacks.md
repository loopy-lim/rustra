---
'@rustra/cli': minor
---

Generate scriptc retained foreign callbacks for asynchronous JSON completion,
events and bytes channels, paired with identity-based native release functions.
Import the generated `scriptc-ffi.ts` source entry for callback signatures;
legacy ambient declarations remain available for synchronous consumers.
The linked Rust static library must include the new scriptc ABI entry points.
