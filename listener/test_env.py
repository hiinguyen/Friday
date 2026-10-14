import os
from pathlib import Path

import pytest

from env import load_env


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in ("FRIDAY_MIC", "FRIDAY_TTS"):
        monkeypatch.setenv(name, "")  # recorded, so the test's writes are undone
        monkeypatch.delenv(name)
    return monkeypatch


def test_settings_are_loaded_without_overriding_the_real_environment(tmp_path: Path, clean_env) -> None:
    file = tmp_path / ".env"
    file.write_text('FRIDAY_MIC=usb-mic\nFRIDAY_TTS="off"\n')
    clean_env.setenv("FRIDAY_TTS", "on")
    load_env(file)
    assert os.environ["FRIDAY_MIC"] == "usb-mic"
    assert os.environ["FRIDAY_TTS"] == "on"


def test_friday_env_file_picks_the_file_or_none(tmp_path: Path, clean_env) -> None:
    file = tmp_path / "other.env"
    file.write_text("FRIDAY_MIC=from-other\n")
    clean_env.setenv("FRIDAY_ENV_FILE", "")
    load_env()
    assert "FRIDAY_MIC" not in os.environ
    clean_env.setenv("FRIDAY_ENV_FILE", str(file))
    load_env()
    assert os.environ["FRIDAY_MIC"] == "from-other"
