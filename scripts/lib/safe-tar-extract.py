#!/usr/bin/env python3
"""Extract a small, trusted-shape tar archive without preserving archive links.

This helper deliberately does not call TarFile.extract(). It validates the complete archive
before writing anything, permits only directories, regular files, and relative in-tree symbolic
links, and materializes each accepted link as an independent regular file. The destination must
not already exist so an archive can never merge with user-controlled filesystem content.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile


MAX_ENTRIES = 4096
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_MATERIALIZED_BYTES = 512 * 1024 * 1024


class UnsafeArchiveError(Exception):
    pass


def archive_path(name: str, label: str) -> PurePosixPath:
    if not name or "\x00" in name or "\\" in name:
        raise UnsafeArchiveError(f"{label} has an empty, NUL-containing, or non-POSIX path: {name!r}")
    value = PurePosixPath(name)
    if (
        value.is_absolute()
        or str(value) != name
        or any(part in ("", ".", "..") for part in value.parts)
    ):
        raise UnsafeArchiveError(f"{label} is not a normalized relative path: {name!r}")
    return value


def resolve_link(member: PurePosixPath, target_text: str, root: str) -> PurePosixPath:
    target = archive_path(target_text, f"symbolic-link target for {member}")
    parts = list(member.parent.parts)
    # archive_path rejects '..', which is stricter than necessary and makes the security boundary
    # reviewable: every upstream link currently names a sibling in the one allowed directory.
    parts.extend(target.parts)
    resolved = PurePosixPath(*parts)
    if not resolved.parts or resolved.parts[0] != root:
        raise UnsafeArchiveError(f"symbolic link escapes archive root: {member} -> {target_text}")
    return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_directory(path: Path) -> None:
    path.mkdir(mode=0o755, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise UnsafeArchiveError(f"extraction parent is not a real directory: {path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("destination")
    parser.add_argument("--root", required=True)
    args = parser.parse_args()

    archive = Path(args.archive).resolve(strict=True)
    destination = Path(args.destination).resolve(strict=False)
    if destination.exists() or destination.is_symlink():
        raise UnsafeArchiveError(f"destination already exists: {destination}")
    ensure_directory(destination.parent)

    entries: dict[PurePosixPath, tarfile.TarInfo] = {}
    with tarfile.open(archive, mode="r:gz") as source:
        members = source.getmembers()
        if not members or len(members) > MAX_ENTRIES:
            raise UnsafeArchiveError(f"archive entry count must be between 1 and {MAX_ENTRIES}")
        for member in members:
            name = archive_path(member.name.rstrip("/") if member.isdir() else member.name, "archive member")
            if name.parts[0] != args.root:
                raise UnsafeArchiveError(f"archive member is outside the single {args.root!r} root: {member.name!r}")
            if name in entries:
                raise UnsafeArchiveError(f"archive contains a duplicate member: {member.name!r}")
            if not (member.isdir() or member.isreg() or member.issym()):
                raise UnsafeArchiveError(f"archive member has a forbidden type: {member.name!r}")
            if member.isreg() and (member.size < 0 or member.size > MAX_FILE_BYTES):
                raise UnsafeArchiveError(f"archive member exceeds the per-file size limit: {member.name!r}")
            if member.issym():
                resolve_link(name, member.linkname, args.root)
            entries[name] = member

        root_path = PurePosixPath(args.root)
        if root_path not in entries or not entries[root_path].isdir():
            raise UnsafeArchiveError(f"archive must contain a directory entry for {args.root!r}")

        def final_regular(member_path: PurePosixPath) -> tuple[PurePosixPath, tarfile.TarInfo]:
            seen: set[PurePosixPath] = set()
            current = member_path
            while True:
                if current in seen:
                    raise UnsafeArchiveError(f"symbolic-link cycle at {member_path}")
                seen.add(current)
                candidate = entries.get(current)
                if candidate is None:
                    raise UnsafeArchiveError(f"symbolic link targets a missing member: {member_path} -> {current}")
                if candidate.isreg():
                    return current, candidate
                if not candidate.issym():
                    raise UnsafeArchiveError(f"symbolic link does not resolve to a regular file: {member_path}")
                current = resolve_link(current, candidate.linkname, args.root)

        materialized_bytes = sum(member.size for member in members if member.isreg())
        resolved_links: dict[PurePosixPath, tuple[PurePosixPath, tarfile.TarInfo]] = {}
        for name, member in entries.items():
            if member.issym():
                resolved_links[name] = final_regular(resolve_link(name, member.linkname, args.root))
                materialized_bytes += resolved_links[name][1].size
        if materialized_bytes > MAX_MATERIALIZED_BYTES:
            raise UnsafeArchiveError("materialized archive exceeds the total size limit")

        destination.mkdir(mode=0o755)
        try:
            for name, member in sorted(entries.items(), key=lambda item: (len(item[0].parts), str(item[0]))):
                relative = PurePosixPath(*name.parts[1:])
                if not relative.parts:
                    continue
                target = destination.joinpath(*relative.parts)
                if member.isdir():
                    ensure_directory(target)
                    os.chmod(target, 0o755, follow_symlinks=False)
                    continue
                if member.isreg():
                    ensure_directory(target.parent)
                    stream = source.extractfile(member)
                    if stream is None:
                        raise UnsafeArchiveError(f"could not read regular member: {member.name!r}")
                    with stream, target.open("xb") as output:
                        shutil.copyfileobj(stream, output, length=1024 * 1024)
                    if target.stat().st_size != member.size:
                        raise UnsafeArchiveError(f"archive member size changed while reading: {member.name!r}")

            # Links are copied only after all regular files exist. A chain always resolves to the
            # final regular archive member, so no filesystem link is ever created or followed.
            for name, (resolved, resolved_member) in sorted(resolved_links.items(), key=lambda item: str(item[0])):
                relative = PurePosixPath(*name.parts[1:])
                resolved_relative = PurePosixPath(*resolved.parts[1:])
                target = destination.joinpath(*relative.parts)
                source_file = destination.joinpath(*resolved_relative.parts)
                ensure_directory(target.parent)
                with source_file.open("rb") as input_file, target.open("xb") as output:
                    shutil.copyfileobj(input_file, output, length=1024 * 1024)
                if target.stat().st_size != resolved_member.size:
                    raise UnsafeArchiveError(f"materialized link size mismatch: {name}")

            report_files = []
            for name, member in sorted(entries.items(), key=lambda item: str(item[0])):
                if member.isdir():
                    continue
                relative = PurePosixPath(*name.parts[1:])
                target = destination.joinpath(*relative.parts)
                if member.issym():
                    resolved, effective = resolved_links[name]
                    source_type = "symlink"
                    link_target = member.linkname
                    resolved_target = str(PurePosixPath(*resolved.parts[1:]))
                else:
                    effective = member
                    source_type = "file"
                    link_target = None
                    resolved_target = None
                executable = bool(effective.mode & 0o111)
                os.chmod(target, 0o755 if executable else 0o644, follow_symlinks=False)
                report_files.append(
                    {
                        "path": str(relative),
                        "sourceType": source_type,
                        **({"linkTarget": link_target, "resolvedTarget": resolved_target} if link_target else {}),
                        "bytes": target.stat().st_size,
                        "sha256": sha256_file(target),
                        "executable": executable,
                    }
                )
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise

    print(
        json.dumps(
            {
                "schemaVersion": 1,
                "archiveRoot": args.root,
                "sourceEntries": len(entries),
                "materializedBytes": materialized_bytes,
                "files": report_files,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UnsafeArchiveError, tarfile.TarError, OSError) as error:
        print(f"safe-tar-extract: {error}", file=sys.stderr)
        raise SystemExit(1)
