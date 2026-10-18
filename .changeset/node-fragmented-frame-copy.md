---
'@rustra/node': patch
---

Avoid repeatedly copying the accumulated response when a binary frame arrives in
multiple stdout chunks. Fragmented frames are joined once after the complete
body arrives; complete frames keep their existing zero-copy view path.
