---
'@rustra/types': minor
---

Emits an opt-in `response.shape` debug warning from the JSON engine when a resolved response looks like a wire-envelope anomaly, for early `RUSTRA_DEBUG` version-skew detection: a double envelope (`{ok:true, result}` seen after the wire layer already decoded one), an `ok:false` resolution without an `error` payload, a payload-less broken envelope, or a resolved failure envelope (`{ok:false, error}` that reached the typed layer as a value instead of a rejection). The warning never throws and never transforms the result; it is gated on debug mode only (a single boolean check per invoke), emits a `kind: 'response.shape'` event with a `reason` identifier and the offending value to the `configureDebug` sink, and stays silent for `undefined`, primitives, and plain domain objects without a boolean `ok` field. `RustraDebugEvent` gains optional `kind` and `reason` diagnostic fields (additive, non-breaking).
