from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol

from .executor import CommandResult, WorkspaceExecutor
from .models import LearnerState, TeachingPacket
from .tutor import TeacherRAG


class CodingModel(Protocol):
    def generate(self, *, system: str, user: str) -> dict[str, object]: ...


@dataclass
class AgentRun:
    goal: str
    success: bool
    iterations: int
    files: list[str] = field(default_factory=list)
    observations: list[str] = field(default_factory=list)
    teaching: TeachingPacket | None = None


SYSTEM = """You are an autonomous coding agent. Return JSON only.
Choose exactly one action per turn:
{"action":"write_file","path":"...","content":"..."}
{"action":"read_file","path":"..."}
{"action":"list_files"}
{"action":"run","argv":["..."]}
{"action":"run_tests","argv":["..."]}
{"action":"finish","summary":"..."}
Work only inside the provided workspace. Build real runnable code and verify it before finish.
Never claim success when the latest relevant verification failed."""


class ExecutingCodingAgent:
    def __init__(
        self,
        *,
        teacher: TeacherRAG,
        model: CodingModel,
        executor: WorkspaceExecutor,
        max_iterations: int = 30,
    ) -> None:
        if max_iterations <= 0:
            raise ValueError("max_iterations must be positive")
        self.teacher = teacher
        self.model = model
        self.executor = executor
        self.max_iterations = max_iterations

    def build(self, goal: str, *, learner: LearnerState | None = None) -> AgentRun:
        if not goal.strip():
            raise ValueError("goal must not be blank")
        teaching = self.teacher.teach(goal, learner=learner)
        history: list[str] = []
        last_tests_passed = False

        for iteration in range(1, self.max_iterations + 1):
            payload = self.model.generate(system=SYSTEM, user=self._prompt(goal, teaching, history))
            if not isinstance(payload, dict):
                history.append("ERROR coding model did not return an object")
                continue
            action = str(payload.get("action", ""))
            try:
                observation, test_state = self._execute(action, payload)
                if action == "run_tests":
                    last_tests_passed = test_state
                elif action in {"write_file", "delete_file"}:
                    last_tests_passed = False
            except Exception as exc:
                observation = f"ERROR {type(exc).__name__}: {exc}"
                if action == "run_tests":
                    last_tests_passed = False
            history.append(f"ACTION {json.dumps(payload, default=str)}\nOBSERVATION {observation}")
            if action == "finish":
                return AgentRun(
                    goal=goal,
                    success=last_tests_passed,
                    iterations=iteration,
                    files=self.executor.list_files(),
                    observations=history,
                    teaching=teaching,
                )

        return AgentRun(
            goal=goal,
            success=False,
            iterations=self.max_iterations,
            files=self.executor.list_files(),
            observations=history,
            teaching=teaching,
        )

    def _execute(self, action: str, payload: dict[str, object]) -> tuple[str, bool]:
        if action == "write_file":
            self.executor.write_file(str(payload["path"]), str(payload.get("content", "")))
            return "file written", False
        if action == "read_file":
            return self.executor.read_file(str(payload["path"])), False
        if action == "list_files":
            return json.dumps(self.executor.list_files()), False
        if action in {"run", "run_tests"}:
            argv = payload.get("argv")
            if argv is not None and (
                not isinstance(argv, list) or not all(isinstance(x, str) for x in argv)
            ):
                raise ValueError("argv must be a list of strings")
            result: CommandResult = (
                self.executor.run_tests(argv) if action == "run_tests" else self.executor.run(argv or [])
            )
            text = f"exit={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            return text, action == "run_tests" and result.ok
        if action == "finish":
            return str(payload.get("summary", "finished")), False
        raise ValueError(f"unsupported action: {action}")

    @staticmethod
    def _prompt(goal: str, teaching: TeachingPacket, history: list[str]) -> str:
        context = "\n\n".join(c.text for c in teaching.context)
        prior = "\n\n".join(history[-12:]) or "No actions yet."
        return f"""GOAL:\n{goal}\n\nTEACHER GUIDANCE:\n{teaching.answer}\n\nRETRIEVED KNOWLEDGE:\n{context}\n\nWORK HISTORY:\n{prior}\n\nChoose the next concrete action."""
