from __future__ import annotations

import argparse
import json
from pathlib import Path

from .coding_agent import ExecutingCodingAgent
from .curriculum import seed_curriculum
from .executor import WorkspaceExecutor
from .models import LearnerState
from .tutor import NVIDIAChatModel, TeacherRAG
from .vectorize import vectorize_repository


def main() -> None:
    parser = argparse.ArgumentParser(prog="teacher-rag")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("seed")

    ask = sub.add_parser("ask")
    ask.add_argument("query")
    ask.add_argument(
        "--level",
        choices=["beginner", "intermediate", "advanced"],
        default="beginner",
    )

    vectorize = sub.add_parser("vectorize")
    vectorize.add_argument("path", nargs="?", default=".")

    prepare = sub.add_parser("prepare")
    prepare.add_argument("path", nargs="?", default=".")

    build = sub.add_parser("build")
    build.add_argument("goal")
    build.add_argument("--workspace", required=True)
    build.add_argument(
        "--level",
        choices=["beginner", "intermediate", "advanced"],
        default="intermediate",
    )
    build.add_argument("--max-iterations", type=int, default=30)

    args = parser.parse_args()
    tutor = TeacherRAG()

    if args.command == "seed":
        print(json.dumps({"chunks_written": seed_curriculum(tutor)}))
        return

    if args.command == "vectorize":
        print(json.dumps(vectorize_repository(tutor, Path(args.path))))
        return

    if args.command == "prepare":
        curriculum_chunks = seed_curriculum(tutor)
        repo_result = vectorize_repository(tutor, Path(args.path))
        print(
            json.dumps(
                {
                    "curriculum_chunks": curriculum_chunks,
                    "repository_files": repo_result["files"],
                    "repository_chunks": repo_result["chunks"],
                    "total_chunks": tutor.store.count(),
                }
            )
        )
        return

    if args.command == "build":
        if not isinstance(tutor.model, NVIDIAChatModel):
            raise SystemExit("teacher-rag build requires NVIDIA_API_KEY")
        workspace = WorkspaceExecutor(Path(args.workspace))
        agent = ExecutingCodingAgent(
            teacher=tutor,
            model=tutor.model,
            executor=workspace,
            max_iterations=args.max_iterations,
        )
        run = agent.build(
            args.goal,
            learner=LearnerState(level=args.level),
        )
        print(
            json.dumps(
                {
                    "goal": run.goal,
                    "success": run.success,
                    "iterations": run.iterations,
                    "files": run.files,
                    "observations": run.observations,
                    "teaching": run.teaching.model_dump() if run.teaching else None,
                    "workspace": str(workspace.root),
                },
                default=str,
            )
        )
        raise SystemExit(0 if run.success else 2)

    if tutor.store.count() == 0:
        seed_curriculum(tutor)
    packet = tutor.teach(args.query, learner=LearnerState(level=args.level))
    print(packet.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
