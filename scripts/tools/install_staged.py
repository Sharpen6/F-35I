"""Copy code that was staged for later into the working tree, as a chain step.

Background renders import modules from scripts/ when they start (clips.py reads the stance from
f35.geom, for example), so new code synced while a render chain is still running could change
frames half way through a clip.  Instead the new files are staged under
renders/frames/staged/<repo-relative path>, and a chain step runs this script once the renders
are done:

    {"script": "../tools/install_staged.py", "args": [], "tag": "install_v54"}

Each staged file is copied over its repo path, then the staged copy is moved to
renders/frames/staged_done/<time>/ so that a later run cannot install it again.
"""
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(REPO, "renders", "frames", "staged")
DONE = os.path.join(REPO, "renders", "frames", "staged_done", time.strftime("%Y%m%d_%H%M%S"))


def main():
    n = 0
    for dirpath, _, files in os.walk(SRC):
        for f in files:
            src = os.path.join(dirpath, f)
            rel = os.path.relpath(src, SRC)
            dst = os.path.join(REPO, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            keep = os.path.join(DONE, rel)
            os.makedirs(os.path.dirname(keep), exist_ok=True)
            shutil.move(src, keep)
            print("STAGED", rel, flush=True)
            n += 1
    print("STAGED total", n, flush=True)
    return n


if __name__ == "__main__":
    main()
    sys.exit(0)
