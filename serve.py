"""Compatibility launcher for the local Node application backend."""
from pathlib import Path
import shutil
import subprocess
import sys

if __name__ == '__main__':
    node = shutil.which('node')
    if not node:
        sys.exit('Install Node.js 24+ and run npm ci inside email-outreach first.')
    try:
        sys.exit(subprocess.call([node, str(Path(__file__).parent / 'scripts' / 'start.mjs')]))
    except KeyboardInterrupt:
        pass
