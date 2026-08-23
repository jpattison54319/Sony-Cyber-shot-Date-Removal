#!/usr/bin/env python3
"""Decode line-delimited base64 chunks from an authenticated Drive fetch.

The Work connector may expose binary payloads through a conversation-scoped
reference that is not an HTTP URL.  This small streaming bridge accepts
independently decodable base64 chunks, one per line, and stops at ``__END__``.
It keeps the complete binary payload out of shell command arguments.
"""

from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--expected-bytes", type=int)
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with args.output.open("wb") as handle:
        for raw_line in sys.stdin.buffer:
            line = raw_line.strip()
            if line == b"__END__":
                break
            if not line:
                continue
            payload = base64.b64decode(line, validate=True)
            handle.write(payload)
            written += len(payload)

    if args.expected_bytes is not None and written != args.expected_bytes:
        args.output.unlink(missing_ok=True)
        raise SystemExit(
            f"decoded byte count {written} does not match expected {args.expected_bytes}"
        )
    print(written)


if __name__ == "__main__":
    main()
