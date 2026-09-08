---
'@rustra/types': minor
---

Adds a device status surface: hosts register a single provider with
`registerDeviceStatusProvider(provider)`, and JS code queries per-capability
`availability` and `permission` through `getDeviceStatus(capability)`.
Queries fail open — without a registered provider the result is
`unknown`/`unknown` (warned once). Two error codes join `RustraErrorCode`
for hosts and derived providers to emit, `device.unavailable` and
`device.permission_denied`; the rustra core itself performs no gating
(availability/permission declaration and OS permission requests stay with
the host).
