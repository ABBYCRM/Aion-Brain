import os

import pytest

from teacher_rag.executor import TemporaryWorkspace


def test_executor_writes_runs_and_tests_real_code():
    ws = TemporaryWorkspace()
    try:
        ws.write_file("calc.py", "def add(a, b):\n    return a + b\n")
        ws.write_file(
            "test_calc.py",
            "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
        )
        result = ws.run_tests()
        assert result.ok, result.stderr
        assert "calc.py" in ws.list_files()
        assert ws.run_python("from calc import add; print(add(4, 5))").stdout.strip() == "9"
    finally:
        ws.close()


def test_executor_blocks_workspace_escape():
    ws = TemporaryWorkspace()
    try:
        with pytest.raises(ValueError, match="escapes workspace"):
            ws.write_file("../escape.txt", "no")
    finally:
        ws.close()


def test_executor_does_not_inherit_deployment_secrets(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "secret-value")
    monkeypatch.setenv("DATABASE_URL", "postgres://secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "also-secret")
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))
    ws = TemporaryWorkspace()
    try:
        result = ws.run_python(
            "import os; print(os.getenv('NVIDIA_API_KEY')); "
            "print(os.getenv('DATABASE_URL')); print(os.getenv('COMPOSIO_API_KEY'))"
        )
        assert result.ok
        assert result.stdout.splitlines() == ["None", "None", "None"]
    finally:
        ws.close()


def test_run_tests_rejects_a_non_test_command():
    ws = TemporaryWorkspace()
    try:
        with pytest.raises(ValueError, match="recognized test command"):
            ws.run_tests(["python", "-c", "print('not a test')"])
    finally:
        ws.close()
