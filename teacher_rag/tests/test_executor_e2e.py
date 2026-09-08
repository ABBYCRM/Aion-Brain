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
        try:
            ws.write_file("../escape.txt", "no")
        except ValueError as exc:
            assert "escapes workspace" in str(exc)
        else:
            raise AssertionError("workspace escape was allowed")
    finally:
        ws.close()
