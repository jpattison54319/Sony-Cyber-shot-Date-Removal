from __future__ import annotations

import sys


def self_check() -> int:
    from PySide6 import QtCore
    from simple_lama_inpainting import SimpleLama

    from date_stamp_cleaner.engine import prepare_engine

    assert QtCore.qVersion()
    assert SimpleLama
    assert callable(prepare_engine())
    return 0


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        raise SystemExit(self_check())
    from date_stamp_cleaner.app import main

    raise SystemExit(main())
