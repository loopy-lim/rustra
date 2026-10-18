"""Generate reproducible small selectors and full-size malformed boundary seeds."""
from pathlib import Path
import sys

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
for mode in (0, 2):
    for selector in range(8):
        (destination / f"mode-{mode}-boundary-{selector}").write_bytes(bytes([mode, selector, 42]))
for size in (65_536, 1024 * 1024, 1024 * 1024 + 1):
    (destination / f"malformed-{size}").write_bytes(b"\x01" + b"\xff" * (size - 1))
print(f"Prepared 19 large-boundary seeds in {destination}")
