#!/usr/bin/env python3
"""
scripts/release/package_connector.py

Deterministic packaging, validation, and checksum verification for CEO Connector releases.
Supports 5 target platforms:
  - Linux x86_64:    ceo-connector-linux-x64.tar.gz
  - Linux aarch64:   ceo-connector-linux-arm64.tar.gz
  - macOS x86_64:    ceo-connector-macos-x64.zip
  - macOS arm64:     ceo-connector-macos-arm64.zip
  - Windows x86_64:  ceo-connector-windows-x64.zip
"""

import argparse
import datetime
import gzip
import hashlib
import io
import os
import pathlib
import re
import stat
import subprocess
import sys
import tarfile
import zipfile

# Exact 5 supported platforms and their artifact contracts
SUPPORTED_PLATFORMS = {
    "linux-x64": {
        "asset": "ceo-connector-linux-x64.tar.gz",
        "format": "tar.gz",
        "binary_name": "ceo-connector",
    },
    "linux-arm64": {
        "asset": "ceo-connector-linux-arm64.tar.gz",
        "format": "tar.gz",
        "binary_name": "ceo-connector",
    },
    "macos-x64": {
        "asset": "ceo-connector-macos-x64.zip",
        "format": "zip",
        "binary_name": "ceo-connector",
    },
    "macos-arm64": {
        "asset": "ceo-connector-macos-arm64.zip",
        "format": "zip",
        "binary_name": "ceo-connector",
    },
    "windows-x64": {
        "asset": "ceo-connector-windows-x64.zip",
        "format": "zip",
        "binary_name": "ceo-connector.exe",
    },
}

REQUIRED_ASSETS_ORDERED = sorted(
    [meta["asset"] for meta in SUPPORTED_PLATFORMS.values()]
)

DEFAULT_README_TEMPLATE = """CEO Connector (ceo-connector) v{version}
=======================================

The Rust-based CEO Connector: a lightweight local daemon & CLI that bridges
durable CEO Server jobs to locally managed execution agents.

Supported Platforms
-------------------
- Linux x86_64
- Linux aarch64
- macOS x86_64 (Intel)
- macOS arm64 (Apple Silicon)
- Windows x86_64

Prerequisites
-------------
- Git: installed and available on PATH (for repository worktrees)
- Orca runtime / CLI: for managing agent runs and session lifecycle
- Local execution Agent: e.g. opencode, Claude Code, Codex, or custom agent

Installation
------------
1. Extract the archive for your platform.
2. Place the executable on your system PATH:
   - Linux/macOS:
     mkdir -p ~/.local/bin
     cp ceo-connector ~/.local/bin/ceo-connector
     chmod +x ~/.local/bin/ceo-connector
   - Windows:
     Copy ceo-connector.exe to a directory on PATH (e.g. %USERPROFILE%\\bin\\).
3. Verify:
   ceo-connector --version

Getting Started
---------------
1. Interactive onboarding:
   ceo-connector setup
2. Or login directly:
   ceo-connector login
3. Inspect status:
   ceo-connector status
4. Run daemon:
   ceo-connector daemon run

Updating
--------
1. Stop any running connector daemon.
2. Replace the executable with the newer verified release artifact.
3. Durable state in ~/.ceo/connector is preserved and schema-compatible.

Uninstalling
------------
1. Remove the executable from your PATH.
2. Optionally delete ~/.ceo/connector to remove local state.
   (Uninstalling local files never deletes Server workspaces or Targets.)

Repository & Documentation
--------------------------
https://github.com/SentimentalK/chief-everything-officer
"""


def parse_cargo_version(cargo_toml_path: str) -> str:
    path = pathlib.Path(cargo_toml_path)
    if not path.is_file():
        raise FileNotFoundError(f"Cargo.toml not found at '{cargo_toml_path}'")
    content = path.read_text(encoding="utf-8")

    # Match version under [package]
    in_package = False
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            in_package = line == "[package]"
            continue
        if in_package and line.startswith("version"):
            m = re.match(r'^version\s*=\s*["\']([^"\']+)["\']', line)
            if m:
                return m.group(1)

    raise ValueError(f"Could not find [package] version in '{cargo_toml_path}'")


def validate_tag(tag: str, cargo_toml_path: str) -> str:
    """
    Validates that tag matches `connector-vX.Y.Z` and equals Cargo.toml version.
    Returns the parsed version string on success, or raises ValueError.
    """
    m = re.match(r"^connector-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$", tag)
    if not m:
        raise ValueError(
            f"Malformed release tag '{tag}'. Expected format: 'connector-vX.Y.Z'"
        )
    tag_version = m.group(1)
    cargo_version = parse_cargo_version(cargo_toml_path)

    if tag_version != cargo_version:
        raise ValueError(
            f"Release tag version mismatch: tag '{tag}' specifies '{tag_version}', "
            f"but '{cargo_toml_path}' specifies '{cargo_version}'."
        )

    return tag_version


def get_deterministic_timestamp(repo_root: str = None) -> int:
    """
    Determines timestamp from:
    1. SOURCE_DATE_EPOCH env var if present
    2. Git commit timestamp of HEAD
    3. Fallback fixed epoch (2026-01-01 00:00:00 UTC = 1767225600)
    """
    if "SOURCE_DATE_EPOCH" in os.environ:
        try:
            return int(os.environ["SOURCE_DATE_EPOCH"])
        except ValueError:
            pass

    try:
        cmd = ["git", "log", "-1", "--format=%ct"]
        cwd = repo_root or os.getcwd()
        out = subprocess.check_output(cmd, cwd=cwd, stderr=subprocess.DEVNULL)
        ts = int(out.strip())
        if ts > 0:
            return ts
    except Exception:
        pass

    return 1767225600


def build_readme_content(version: str, custom_readme_path: str = None) -> bytes:
    if custom_readme_path and os.path.isfile(custom_readme_path):
        return pathlib.Path(custom_readme_path).read_bytes()
    return DEFAULT_README_TEMPLATE.format(version=version).encode("utf-8")


def check_for_license_file(repo_root: str = None) -> bytes:
    """
    Check if a real repo license file exists. Returns bytes if found, else None.
    Do NOT invent licensing if not present.
    """
    root = pathlib.Path(repo_root or os.getcwd())
    for name in ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE"]:
        cand = root / name
        if cand.is_file():
            return cand.read_bytes()
    return None


def create_tar_gz_archive(output_path: str, entries: list, timestamp: int):
    """
    Creates a bit-for-bit deterministic .tar.gz archive.
    - entries: list of dicts with keys:
      'name': archive path (e.g. 'ceo-connector-2.4.0/README.txt')
      'type': 'dir' or 'file'
      'mode': octal permission (0o755 or 0o644)
      'data': bytes (if file)
    """
    entries = sorted(entries, key=lambda e: e["name"])
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    with open(output_path, "wb") as f:
        # Gzip mtime=0.0 strips current timestamp from gzip header
        with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0.0) as gz:
            with tarfile.open(mode="w", fileobj=gz) as tar:
                for entry in entries:
                    ti = tarfile.TarInfo(name=entry["name"])
                    ti.mtime = timestamp
                    ti.uid = 0
                    ti.gid = 0
                    ti.uname = ""
                    ti.gname = ""
                    ti.mode = entry["mode"]
                    if entry["type"] == "dir":
                        ti.type = tarfile.DIRTYPE
                        ti.size = 0
                        tar.addfile(ti)
                    else:
                        ti.type = tarfile.REGTYPE
                        data = entry["data"]
                        ti.size = len(data)
                        tar.addfile(ti, io.BytesIO(data))


def create_zip_archive(output_path: str, entries: list, timestamp: int):
    """
    Creates a bit-for-bit deterministic .zip archive.
    """
    entries = sorted(entries, key=lambda e: e["name"])
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    dt = datetime.datetime.fromtimestamp(timestamp, tz=datetime.timezone.utc)
    zip_dt = (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            name = entry["name"]
            if entry["type"] == "dir" and not name.endswith("/"):
                name += "/"
            zi = zipfile.ZipInfo(name, date_time=zip_dt)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 3  # UNIX
            if entry["type"] == "dir":
                # S_IFDIR = 0o040000; DOS directory flag = 0x10
                zi.external_attr = ((entry["mode"] | 0o040000) << 16) | 0x10
                zf.writestr(zi, b"")
            else:
                # S_IFREG = 0o100000; DOS archive flag = 0x20
                zi.external_attr = ((entry["mode"] | 0o100000) << 16) | 0x20
                zf.writestr(zi, entry["data"])


def package_connector(
    platform_key: str,
    binary_path: str,
    output_dir: str,
    version: str,
    readme_path: str = None,
    repo_root: str = None,
    source_date_epoch: int = None,
) -> str:
    """
    Packages the connector binary for `platform_key` into `output_dir`.
    Returns the absolute path to the created archive.
    """
    if platform_key not in SUPPORTED_PLATFORMS:
        raise ValueError(
            f"Unsupported platform '{platform_key}'. Supported: {list(SUPPORTED_PLATFORMS.keys())}"
        )

    plat_info = SUPPORTED_PLATFORMS[platform_key]
    bin_file = pathlib.Path(binary_path)
    if not bin_file.is_file():
        raise FileNotFoundError(f"Connector binary not found at '{binary_path}'")

    bin_data = bin_file.read_bytes()
    if len(bin_data) == 0:
        raise ValueError(f"Connector binary at '{binary_path}' is empty")

    top_dir = f"ceo-connector-{version}"
    expected_bin_name = plat_info["binary_name"]

    entries = [
        {
            "name": f"{top_dir}/",
            "type": "dir",
            "mode": 0o755,
            "data": None,
        },
        {
            "name": f"{top_dir}/README.txt",
            "type": "file",
            "mode": 0o644,
            "data": build_readme_content(version, readme_path),
        },
        {
            "name": f"{top_dir}/{expected_bin_name}",
            "type": "file",
            "mode": 0o755,
            "data": bin_data,
        },
    ]

    license_bytes = check_for_license_file(repo_root)
    if license_bytes:
        entries.append(
            {
                "name": f"{top_dir}/LICENSE",
                "type": "file",
                "mode": 0o644,
                "data": license_bytes,
            }
        )

    timestamp = (
        source_date_epoch
        if source_date_epoch is not None
        else get_deterministic_timestamp(repo_root)
    )

    output_archive_path = os.path.join(output_dir, plat_info["asset"])

    if plat_info["format"] == "tar.gz":
        create_tar_gz_archive(output_archive_path, entries, timestamp)
    elif plat_info["format"] == "zip":
        create_zip_archive(output_archive_path, entries, timestamp)
    else:
        raise ValueError(f"Unknown format {plat_info['format']}")

    # Immediately verify the created archive
    verify_archive(output_archive_path, platform_key, version)

    return os.path.abspath(output_archive_path)


def verify_archive(archive_path: str, platform_key: str, version: str):
    """
    Verifies that the archive matches the exact release contract:
    - Exactly one top-level directory: `ceo-connector-<version>/`
    - Contains exactly the allowed files:
      * `README.txt`
      * `ceo-connector` (or `ceo-connector.exe` for windows)
      * `LICENSE` (only if repo has one)
    - Rejects any other file, nested dir, host junk, git, or target junk.
    - Validates executable mode (0o755).
    """
    path = pathlib.Path(archive_path)
    if not path.is_file():
        raise FileNotFoundError(f"Archive not found: '{archive_path}'")
    if path.stat().st_size == 0:
        raise ValueError(f"Archive is empty: '{archive_path}'")

    if platform_key not in SUPPORTED_PLATFORMS:
        raise ValueError(f"Unknown platform key '{platform_key}'")

    plat_info = SUPPORTED_PLATFORMS[platform_key]
    top_dir = f"ceo-connector-{version}"
    expected_bin = plat_info["binary_name"]

    allowed_filenames = {"README.txt", expected_bin}
    license_bytes = check_for_license_file()
    if license_bytes:
        allowed_filenames.add("LICENSE")

    found_members = set()
    executable_ok = False

    if plat_info["format"] == "tar.gz":
        with tarfile.open(archive_path, "r:gz") as tar:
            for member in tar.getmembers():
                name = member.name.rstrip("/")
                if name == top_dir:
                    if not member.isdir():
                        raise ValueError(f"Top-level entry '{name}' must be a directory")
                    continue

                if not member.name.startswith(f"{top_dir}/"):
                    raise ValueError(
                        f"Entry '{member.name}' is outside top-level directory '{top_dir}/'"
                    )

                rel_name = member.name[len(top_dir) + 1 :].rstrip("/")
                if "/" in rel_name:
                    raise ValueError(
                        f"Unexpected nested directory structure in archive: '{member.name}'"
                    )

                if rel_name not in allowed_filenames:
                    raise ValueError(
                        f"Unexpected file in archive '{archive_path}': '{rel_name}'. "
                        f"Allowed files: {allowed_filenames}"
                    )

                found_members.add(rel_name)

                if rel_name == expected_bin:
                    if (member.mode & 0o111) == 0:
                        raise ValueError(
                            f"Binary '{rel_name}' does not have executable permission in '{archive_path}' (mode={oct(member.mode)})"
                        )
                    executable_ok = True
                elif rel_name == "README.txt":
                    if not member.isreg():
                        raise ValueError("README.txt is not a regular file")

    elif plat_info["format"] == "zip":
        with zipfile.ZipFile(archive_path, "r") as zf:
            for zinfo in zf.infolist():
                name = zinfo.filename.rstrip("/")
                if name == top_dir:
                    continue

                if not zinfo.filename.startswith(f"{top_dir}/"):
                    raise ValueError(
                        f"Entry '{zinfo.filename}' is outside top-level directory '{top_dir}/'"
                    )

                rel_name = zinfo.filename[len(top_dir) + 1 :].rstrip("/")
                if "/" in rel_name:
                    raise ValueError(
                        f"Unexpected nested directory structure in archive: '{zinfo.filename}'"
                    )

                if rel_name not in allowed_filenames:
                    raise ValueError(
                        f"Unexpected file in archive '{archive_path}': '{rel_name}'. "
                        f"Allowed files: {allowed_filenames}"
                    )

                found_members.add(rel_name)

                mode = zinfo.external_attr >> 16
                if rel_name == expected_bin:
                    if mode != 0 and (mode & 0o111) == 0:
                        raise ValueError(
                            f"Binary '{rel_name}' does not have executable permission in '{archive_path}' (mode={oct(mode)})"
                        )
                    executable_ok = True
                elif rel_name == "README.txt":
                    pass

    missing = {"README.txt", expected_bin} - found_members
    if missing:
        raise ValueError(
            f"Archive '{archive_path}' is missing required files: {missing}"
        )
    if not executable_ok:
        raise ValueError(
            f"Archive '{archive_path}' is missing valid executable '{expected_bin}'"
        )


def compute_sha256(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def generate_checksums(dist_dir: str, output_file: str = None) -> str:
    """
    Computes SHA256SUMS over the exactly five required archives in deterministic
    lexicographical order.
    """
    dist = pathlib.Path(dist_dir)
    if not dist.is_dir():
        raise FileNotFoundError(f"Distribution directory '{dist_dir}' not found")

    lines = []
    for asset_name in REQUIRED_ASSETS_ORDERED:
        asset_path = dist / asset_name
        if not asset_path.is_file():
            raise FileNotFoundError(
                f"Missing required release asset '{asset_name}' in '{dist_dir}'"
            )
        digest = compute_sha256(str(asset_path))
        lines.append(f"{digest}  {asset_name}\n")

    out_path = pathlib.Path(output_file or (dist / "SHA256SUMS"))
    out_path.write_text("".join(lines), encoding="utf-8")
    return str(out_path)


def verify_checksums(dist_dir: str, checksum_file: str = None):
    """
    Verifies that SHA256SUMS contains exactly the five archives in lexicographical
    order and that every checksum matches.
    """
    dist = pathlib.Path(dist_dir)
    cksum_path = pathlib.Path(checksum_file or (dist / "SHA256SUMS"))
    if not cksum_path.is_file():
        raise FileNotFoundError(f"Checksum file '{cksum_path}' not found")

    lines = cksum_path.read_text(encoding="utf-8").splitlines()
    if len(lines) != len(REQUIRED_ASSETS_ORDERED):
        raise ValueError(
            f"Expected exactly {len(REQUIRED_ASSETS_ORDERED)} lines in '{cksum_path}', found {len(lines)}"
        )

    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2:
            raise ValueError(f"Malformed checksum line in '{cksum_path}': '{line}'")
        expected_digest, asset_name = parts[0], parts[1]

        # Verify lexicographical order
        expected_asset = REQUIRED_ASSETS_ORDERED[i]
        if asset_name != expected_asset:
            raise ValueError(
                f"Checksum file ordering error at line {i+1}: expected '{expected_asset}', found '{asset_name}'"
            )

        asset_path = dist / asset_name
        if not asset_path.is_file():
            raise FileNotFoundError(f"Asset '{asset_name}' not found in '{dist_dir}'")

        actual_digest = compute_sha256(str(asset_path))
        if actual_digest.lower() != expected_digest.lower():
            raise ValueError(
                f"Checksum mismatch for '{asset_name}': expected {expected_digest}, computed {actual_digest}"
            )


def generate_release_notes(version: str, output_file: str = None) -> str:
    content = f"""# CEO Connector {version}

Deterministic release of CEO Connector {version} across five supported platforms.

## Supported Platforms
- **Linux x86_64** (`ceo-connector-linux-x64.tar.gz`): Native build (glibc 2.35+)
- **Linux aarch64** (`ceo-connector-linux-arm64.tar.gz`): Cross-compiled build for 64-bit ARM Linux
- **macOS x86_64** (`ceo-connector-macos-x64.zip`): Native build for Intel Macs
- **macOS arm64** (`ceo-connector-macos-arm64.zip`): Native build for Apple Silicon Macs
- **Windows x86_64** (`ceo-connector-windows-x64.zip`): Native MSVC build for Windows 10/11

## Prerequisites
- **Git** (available on PATH for repository worktrees and state tracking)
- **Orca runtime / CLI** (for managing agent runs and session lifecycle)
- **Local execution Agent** (e.g. `opencode`, Claude Code, Codex, or custom agent)

## Verification
Verify your download using `SHA256SUMS`:
```bash
sha256sum -c SHA256SUMS
```
Or on Windows PowerShell:
```powershell
Get-FileHash ceo-connector-windows-x64.zip -Algorithm SHA256
```

## Quick Start
Extract the archive for your platform, place `ceo-connector` (or `ceo-connector.exe`) on your PATH, and run:
```bash
ceo-connector --version
ceo-connector setup
```
"""
    if output_file:
        pathlib.Path(output_file).write_text(content, encoding="utf-8")
        return output_file
    return content


def main():
    parser = argparse.ArgumentParser(
        description="Deterministic packaging and release tooling for CEO Connector"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # validate-tag
    p_tag = subparsers.add_parser("validate-tag", help="Validate release tag against Cargo.toml")
    p_tag.add_argument("--tag", required=True, help="Tag name (e.g. connector-v2.4.0)")
    p_tag.add_argument(
        "--cargo-toml",
        default="connector/Cargo.toml",
        help="Path to connector Cargo.toml",
    )

    # package
    p_pkg = subparsers.add_parser("package", help="Create deterministic archive for a platform")
    p_pkg.add_argument(
        "--platform",
        required=True,
        choices=list(SUPPORTED_PLATFORMS.keys()),
        help="Target platform identifier",
    )
    p_pkg.add_argument("--binary-path", required=True, help="Path to built binary")
    p_pkg.add_argument("--output-dir", default="dist", help="Output directory")
    p_pkg.add_argument(
        "--version",
        help="Connector version (defaults to parsing connector/Cargo.toml)",
    )
    p_pkg.add_argument(
        "--cargo-toml",
        default="connector/Cargo.toml",
        help="Path to connector Cargo.toml",
    )
    p_pkg.add_argument("--readme-path", help="Path to custom README.txt")
    p_pkg.add_argument("--source-date-epoch", type=int, help="Deterministic timestamp override")

    # verify-archive
    p_ver = subparsers.add_parser("verify-archive", help="Verify archive contents and layout")
    p_ver.add_argument("--archive-path", required=True, help="Path to archive")
    p_ver.add_argument(
        "--platform",
        required=True,
        choices=list(SUPPORTED_PLATFORMS.keys()),
        help="Target platform identifier",
    )
    p_ver.add_argument(
        "--version",
        help="Expected version (defaults to parsing connector/Cargo.toml)",
    )
    p_ver.add_argument(
        "--cargo-toml",
        default="connector/Cargo.toml",
        help="Path to connector Cargo.toml",
    )

    # generate-checksums
    p_cksum = subparsers.add_parser(
        "generate-checksums", help="Compute SHA256SUMS for the five archives"
    )
    p_cksum.add_argument("--dist-dir", default="dist", help="Directory with archives")
    p_cksum.add_argument("--output", help="Output path for SHA256SUMS")

    # verify-checksums
    p_vcksum = subparsers.add_parser(
        "verify-checksums", help="Verify SHA256SUMS against dist archives"
    )
    p_vcksum.add_argument("--dist-dir", default="dist", help="Directory with archives")
    p_vcksum.add_argument("--checksum-file", help="Path to SHA256SUMS")

    # generate-release-notes
    p_notes = subparsers.add_parser(
        "generate-release-notes", help="Generate markdown release notes"
    )
    p_notes.add_argument(
        "--version",
        help="Version string (defaults to connector/Cargo.toml)",
    )
    p_notes.add_argument(
        "--cargo-toml",
        default="connector/Cargo.toml",
        help="Path to connector Cargo.toml",
    )
    p_notes.add_argument("--output", help="Output file path")

    args = parser.parse_args()

    try:
        if args.command == "validate-tag":
            ver = validate_tag(args.tag, args.cargo_toml)
            print(f"PASS: Release tag '{args.tag}' matches Cargo.toml version '{ver}'.")

        elif args.command == "package":
            ver = args.version or parse_cargo_version(args.cargo_toml)
            out = package_connector(
                platform_key=args.platform,
                binary_path=args.binary_path,
                output_dir=args.output_dir,
                version=ver,
                readme_path=args.readme_path,
                source_date_epoch=args.source_date_epoch,
            )
            sha = compute_sha256(out)
            size = os.path.getsize(out)
            print(f"PASS: Created {out} ({size} bytes, sha256={sha})")

        elif args.command == "verify-archive":
            ver = args.version or parse_cargo_version(args.cargo_toml)
            verify_archive(args.archive_path, args.platform, ver)
            print(f"PASS: Archive '{args.archive_path}' verified against release contract.")

        elif args.command == "generate-checksums":
            out = generate_checksums(args.dist_dir, args.output)
            print(f"PASS: Generated checksums at '{out}':\n" + pathlib.Path(out).read_text())

        elif args.command == "verify-checksums":
            verify_checksums(args.dist_dir, args.checksum_file)
            print(f"PASS: All five release asset checksums verified successfully.")

        elif args.command == "generate-release-notes":
            ver = args.version or parse_cargo_version(args.cargo_toml)
            out = generate_release_notes(ver, args.output)
            if args.output:
                print(f"PASS: Generated release notes at '{out}'")
            else:
                print(out)

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
