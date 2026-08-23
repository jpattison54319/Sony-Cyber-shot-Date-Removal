from __future__ import annotations

import hashlib
import importlib
import os
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any


EXPECTED_MODEL_SHA256 = "7ba7aa7ac37a4d41fdbbeba3a2af7ead18058552997e3a3cd1a3b2210c9e6b4c"
MODEL_FILENAME = "big-lama.pt"


class EngineConfigurationError(RuntimeError):
    """Raised when the packaged workflow or model cannot be trusted."""


def _resource_root() -> Path:
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        return Path(frozen_root)
    return Path(__file__).resolve().parents[1]


def _source_workflow_root() -> Path:
    return Path(__file__).resolve().parents[2] / "reference" / "python-workflow"


def locate_model() -> Path:
    configured = os.environ.get("LAMA_MODEL")
    if configured:
        return Path(configured).expanduser().resolve()
    return _resource_root() / "models" / MODEL_FILENAME


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model(path: Path) -> None:
    if not path.is_file():
        raise EngineConfigurationError(
            "The restoration model is missing. Reinstall Date Stamp Cleaner from an official release."
        )
    actual = sha256_file(path)
    if actual != EXPECTED_MODEL_SHA256:
        raise EngineConfigurationError(
            "The restoration model failed its integrity check. Reinstall Date Stamp Cleaner."
        )


def _load_workflow() -> ModuleType:
    try:
        return importlib.import_module("bulk_timestamp_pipeline")
    except ModuleNotFoundError:
        workflow_root = _source_workflow_root()
        if not workflow_root.is_dir():
            raise EngineConfigurationError("The audited Python workflow is missing.") from None
        sys.path.insert(0, str(workflow_root))
        try:
            return importlib.import_module("bulk_timestamp_pipeline")
        except ModuleNotFoundError as error:
            raise EngineConfigurationError("The audited Python workflow could not be loaded.") from error


def prepare_engine() -> Callable[[Path, Path, Path | None, Path | None, str], dict[str, Any]]:
    model_path = locate_model()
    verify_model(model_path)
    os.environ["LAMA_MODEL"] = str(model_path)

    workflow = _load_workflow()
    workflow_digest = getattr(workflow, "EXPECTED_LAMA_SHA256", None)
    if workflow_digest != EXPECTED_MODEL_SHA256:
        raise EngineConfigurationError("The workflow and packaged model do not agree on identity.")
    process = getattr(workflow, "process", None)
    if not callable(process):
        raise EngineConfigurationError("The audited Python workflow has no processing entry point.")
    return process
