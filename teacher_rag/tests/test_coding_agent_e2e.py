from teacher_rag import ExecutingCodingAgent, TemporaryWorkspace
from teacher_rag.config import Settings
from teacher_rag.curriculum import seed_curriculum
from teacher_rag.tutor import TeacherRAG


class ScriptedCodingModel:
    def __init__(self):
        self.i = 0
        self.actions = [
            {
                "action": "write_file",
                "path": "app.py",
                "content": "def greet(name):\n    return f'Hello, {name}!'\n",
            },
            {
                "action": "write_file",
                "path": "test_app.py",
                "content": (
                    "from app import greet\n\n"
                    "def test_greet():\n"
                    "    assert greet('AI') == 'Hello, AI!'\n"
                ),
            },
            {"action": "run_tests", "argv": None},
            {"action": "finish", "summary": "implemented and tested"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def build_with_model(tmp_path, model, goal="Build verified code"):
    teacher = TeacherRAG(Settings(db_path=tmp_path / "rag.sqlite3"))
    seed_curriculum(teacher)
    ws = TemporaryWorkspace()
    run = ExecutingCodingAgent(
        teacher=teacher,
        model=model,
        executor=ws,
    ).build(goal)
    return run, ws


def test_agent_builds_and_executes_real_code(tmp_path):
    run, ws = build_with_model(
        tmp_path,
        ScriptedCodingModel(),
        "Build and test a Python greeting function",
    )
    try:
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
            {
                "action": "write_file",
                "path": "test_x.py",
                "content": "def test_ok():\n    assert True\n",
            },
            {"action": "run_tests", "argv": None},
            {
                "action": "write_file",
                "path": "x.py",
                "content": "raise RuntimeError('unverified change')\n",
            },
            {"action": "finish", "summary": "done"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def test_agent_invalidates_success_after_unverified_write(tmp_path):
    run, ws = build_with_model(tmp_path, WritesAfterTestsModel())
    try:
        assert run.success is False
    finally:
        ws.close()


class RunsAfterTestsModel:
    def __init__(self):
        self.i = 0
        self.actions = [
            {
                "action": "write_file",
                "path": "test_x.py",
                "content": "def test_ok():\n    assert True\n",
            },
            {"action": "run_tests", "argv": None},
            {
                "action": "run",
                "argv": ["python", "-c", "open('mutated.txt','w').write('changed')"],
            },
            {"action": "finish", "summary": "done"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def test_agent_invalidates_success_after_arbitrary_run(tmp_path):
    run, ws = build_with_model(tmp_path, RunsAfterTestsModel())
    try:
        assert run.success is False
        assert "mutated.txt" in run.files
    finally:
        ws.close()


class FakeTestCommandModel:
    def __init__(self):
        self.i = 0
        self.actions = [
            {"action": "run_tests", "argv": ["python", "-c", "print('not tests')"]},
            {"action": "finish", "summary": "done"},
        ]

    def generate(self, *, system, user):
        del system, user
        action = self.actions[self.i]
        self.i += 1
        return action


def test_agent_rejects_non_test_command_as_verification(tmp_path):
    run, ws = build_with_model(tmp_path, FakeTestCommandModel())
    try:
        assert run.success is False
        assert any("recognized test command" in item for item in run.observations)
    finally:
        ws.close()
