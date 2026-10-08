#!/usr/bin/env python3
"""Pack the selected espeak-ng-data files into a deterministic ustar archive.

usage: pack_data.py <espeak-ng-data dir> <out.tar> <relpath> [<relpath> ...]

Entries are stored as "espeak-ng-data/<relpath>" in the given order (directory
entries are not stored; the loader creates parent directories), with
mtime=0, uid=gid=0, empty user/group names and mode 0644, so the archive is
byte-for-byte reproducible from identical inputs.
"""
import io
import sys
import tarfile
from pathlib import Path


def main(argv):
    src = Path(argv[1])
    out = Path(argv[2])
    rels = argv[3:]
    if not rels:
        raise SystemExit("no files given")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for rel in rels:
            data = (src / rel).read_bytes()
            info = tarfile.TarInfo("espeak-ng-data/" + rel)
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.type = tarfile.REGTYPE
            tar.addfile(info, io.BytesIO(data))
    out.write_bytes(buf.getvalue())


if __name__ == "__main__":
    main(sys.argv)
