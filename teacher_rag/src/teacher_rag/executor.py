from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CommandResult:
    command: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_seconds: float

    @property
    def ok(self) -> bool:
        return self.returncode == 0


class WorkspaceExecutor:
    """Constrained filesystem + process execution surface for a coding agent."""

    def __init__(self, root: str | Path, *, timeout: float = 60.0) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout

    def _path(self, relative: str | Path) -> Path:
        candidate = (self.root / relative).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError("path escapes workspace")
        return candidate

    def list_files(self) -> list[str]:
        return sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*") if p.is_file())

    def read_file(self, path: str) -> str:
        return self._path(path).read_text(encoding="utf-8")

    def write_file(self, path: str, content: str) -> None:
        target = self._path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def delete_file(self, path: str) -> None:
        target = self._path(path)
        if target.is_file():
            target.unlink()

    def run(self, argv: list[str], *, timeout: float | None = None) -> CommandResult:
        if not argv or not all(isinstance(x, str) and x for x in argv):
            raise ValueError("argv must contain non-empty strings")
        started = time.monotonic()
        proc = subprocess.run(
            argv,
            cwd=self.root,
            env=os.environ.copy(),
            text=True,
            capture_output=True,
            timeout=timeout or self.timeout,
            shell=False,
            check=False,
        )
        return CommandResult(argv, proc.returncode, proc.stdout, proc.stderr, time.monotonic() - started)

    def run_python(self, code: str) -> CommandResult:
        return self.run([sys.executable, "-c", code])

    def run_tests(self, argv: list[str] | None = None) -> CommandResult:
        return self.run(argv or [sys.executable, "-m", "pytest", "-q"])


class TemporaryWorkspace(WorkspaceExecutor):
    def __init__(self, *, timeout: float = 60.0) -> None:
        self._tempdir = tempfile.TemporaryDirectory(prefix="teacher-rag-")
        super().__init__(self._tempdir.name, timeout=timeout)

    def close(self) -> None:
        self._tempdir.cleanup()
