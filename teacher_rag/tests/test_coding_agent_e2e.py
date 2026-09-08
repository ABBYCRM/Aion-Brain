from teacher_rag import ExecutingCodingAgent, TemporaryWorkspace
from teacher_rag.config import Settings
from teacher_rag.curriculum import seed_curriculum
from teacher_rag.tutor import TeacherRAG


class ScriptedCodingModel:
    def __init__(self):
        self.i = 0
        self.actions = [
            {"action": "write_file", "path": "app.py", "content": "def greet(name):\n    return f'Hello, {name}!'\n"},
            {"action": "write_file", "path": "test_app.py", "content": "from app import greet\n\ndef test_greet():\n    assert greet('AI') == 'Hello, AI!'\n"},
            {"action": "run_tests", "argv": None},
            {"action": "finish", "summary": "implemented and tested"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def test_agent_builds_and_executes_real_code(tmp_path):
    teacher = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3"))
    seed_curriculum(teacher)
    ws = TemporaryWorkspace()
    try:
        run = ExecutingCodingAgent(
            teacher=teacher,
            model=ScriptedCodingModel(),
            executor=ws,
        ).build("Build and test a Python greeting function")
        assert run.success is True
        assert "app.py" in run.files
        assert "test_app.py" in run.files
        assert any("exit=0" in item for item in run.observations)
    finally:
        ws.close()


class WritesAfterTestsModel:
    def __init__(self):
        self.i = 0
        self.actions = [
            {"action": "write_file", "path": "test_x.py", "content": "def test_ok():\n    assert True\n"},
            {"action": "run_tests", "argv": None},
            {"action": "write_file", "path": "x.py", "content": "raise RuntimeError('unverified change')\n"},
            {"action": "finish", "summary": "done"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def test_agent_invalidates_success_after_unverified_write(tmp_path):
    teacher = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3"))
    seed_curriculum(teacher)
    ws = TemporaryWorkspace()
    try:
        run = ExecutingCodingAgent(
            teacher=teacher,
            model=WritesAfterTestsModel(),
            executor=ws,
        ).build("Create a verified Python file")
        assert run.success is False
    finally:
        ws.close()
