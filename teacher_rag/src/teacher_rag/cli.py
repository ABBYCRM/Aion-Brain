from __future__ import annotations

import argparse
import json
from pathlib import Path

from .curriculum import seed_curriculum
from .models import LearnerState
from .tutor import TeacherRAG
from .vectorize import vectorize_repository


def main() -> None:
    parser = argparse.ArgumentParser(prog="teacher-rag")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("seed")
    ask = sub.add_parser("ask")
    ask.add_argument("query")
    ask.add_argument("--level", choices=["beginner", "intermediate", "advanced"], default="beginner")
    vectorize = sub.add_parser("vectorize")
    vectorize.add_argument("path", nargs="?", default=".")
    args = parser.parse_args()

    tutor = TeacherRAG()
    if args.command == "seed":
        print(json.dumps({"chunks_written": seed_curriculum(tutor)}))
    elif args.command == "vectorize":
        print(json.dumps(vectorize_repository(tutor, Path(args.path))))
    else:
        packet = tutor.teach(args.query, learner=LearnerState(level=args.level))
        print(packet.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
