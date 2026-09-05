"""Python entry point for Aion's real corpus-backed SQM builder (no dependencies).

Uses the same implementation as the API and Node CLI, so topic selection and
JSON/Markdown exports cannot drift. Requires Node.js 18+ alongside Python 3.
"""
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    node = shutil.which('node')
    if not node:
        print('Node.js 18+ is required. Run this in the Aion-Brain container or install Node.js.', file=sys.stderr)
        return 1
    root = Path(__file__).resolve().parent
    return subprocess.call([node, str(root / 'bin' / 'sqm.mjs'), *sys.argv[1:]], cwd=root)


if __name__ == '__main__':
    raise SystemExit(main())
