"""Benchmark preparation only: evict this input, never the system-wide cache.

No calculations or file changes occur here. The solver remains pure Node.js.
The kernel treats POSIX_FADV_DONTNEED as advice; GNU time's filesystem-input
counter in compare.mjs lets us check that the subsequent run really reads disk.
"""

import os
import sys

fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
finally:
    os.close(fd)
