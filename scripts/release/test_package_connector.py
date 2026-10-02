#!/usr/bin/env python3
"""
Unit tests for CEO Connector packaging, determinism, and release verification.
"""

import gzip
import io
import os
import pathlib
import shutil
import tarfile
import tempfile
import unittest
import zipfile

import package_connector


class TestPackageConnector(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.cargo_toml = os.path.join(self.temp_dir, "Cargo.toml")
        pathlib.Path(self.cargo_toml).write_text(
            """[package]
name = "ceo-connector"
version = "2.4.1"
edition = "2021"
""",
            encoding="utf-8",
        )

        # Create dummy binaries
        self.unix_bin = os.path.join(self.temp_dir, "ceo-connector")
        pathlib.Path(self.unix_bin).write_bytes(b"\x7fELFfakebinarycontents1234567890")
        os.chmod(self.unix_bin, 0o755)

        self.win_bin = os.path.join(self.temp_dir, "ceo-connector.exe")
        pathlib.Path(self.win_bin).write_bytes(b"MZfakebinarycontents1234567890")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_validate_tag_success(self):
        ver = package_connector.validate_tag("connector-v2.4.1", self.cargo_toml)
        self.assertEqual(ver, "2.4.1")

    def test_validate_tag_mismatch(self):
        with self.assertRaises(ValueError) as ctx:
            package_connector.validate_tag("connector-v2.4.0", self.cargo_toml)
        self.assertIn("version mismatch", str(ctx.exception))

    def test_validate_tag_malformed(self):
        bad_tags = ["v2.4.1", "connector-2.4.1", "connector-v2.4", "release-2.4.1", "connector-v"]
        for bad in bad_tags:
            with self.subTest(tag=bad):
                with self.assertRaises(ValueError) as ctx:
                    package_connector.validate_tag(bad, self.cargo_toml)
                self.assertIn("Malformed release tag", str(ctx.exception))

    def test_readme_command_uses_valid_run_syntax(self):
        # Must contain valid 'ceo-connector run'
        self.assertIn("ceo-connector run", package_connector.DEFAULT_README_TEMPLATE)
        # Must NOT contain invalid 'ceo-connector daemon run'
        self.assertNotIn("ceo-connector daemon run", package_connector.DEFAULT_README_TEMPLATE)

        # Verify built readme content bytes
        built = package_connector.build_readme_content("2.4.1").decode("utf-8")
        self.assertIn("ceo-connector run", built)
        self.assertNotIn("ceo-connector daemon run", built)

    def test_package_tar_gz_determinism_and_layout(self):
        out_dir1 = os.path.join(self.temp_dir, "out1")
        out_dir2 = os.path.join(self.temp_dir, "out2")

        fixed_epoch = 1704067200
        p1 = package_connector.package_connector(
            platform_key="linux-x64",
            binary_path=self.unix_bin,
            output_dir=out_dir1,
            version="2.4.1",
            source_date_epoch=fixed_epoch,
        )
        p2 = package_connector.package_connector(
            platform_key="linux-x64",
            binary_path=self.unix_bin,
            output_dir=out_dir2,
            version="2.4.1",
            source_date_epoch=fixed_epoch,
        )

        # Proves identical bytes and identical SHA256
        bytes1 = pathlib.Path(p1).read_bytes()
        bytes2 = pathlib.Path(p2).read_bytes()
        self.assertEqual(bytes1, bytes2)

        sha1 = package_connector.compute_sha256(p1)
        sha2 = package_connector.compute_sha256(p2)
        self.assertEqual(sha1, sha2)

        # Verify archive layout
        with tarfile.open(p1, "r:gz") as tar:
            names = [m.name for m in tar.getmembers()]
            self.assertEqual(
                names,
                [
                    "ceo-connector-2.4.1",
                    "ceo-connector-2.4.1/README.txt",
                    "ceo-connector-2.4.1/ceo-connector",
                ],
            )
            # Check permissions
            dir_member = tar.getmember("ceo-connector-2.4.1")
            self.assertTrue(dir_member.isdir())
            self.assertEqual(dir_member.mode & 0o777, 0o755)

            bin_member = tar.getmember("ceo-connector-2.4.1/ceo-connector")
            self.assertTrue(bin_member.isfile())
            self.assertEqual(bin_member.mode & 0o777, 0o755)

            readme_member = tar.getmember("ceo-connector-2.4.1/README.txt")
            self.assertTrue(readme_member.isfile())
            self.assertEqual(readme_member.mode & 0o777, 0o644)

            # Check packaged README.txt contents
            readme_data = tar.extractfile(readme_member).read().decode("utf-8")
            self.assertIn("ceo-connector run", readme_data)
            self.assertNotIn("ceo-connector daemon run", readme_data)

    def test_package_zip_determinism_and_layout(self):
        out_dir1 = os.path.join(self.temp_dir, "out_zip1")
        out_dir2 = os.path.join(self.temp_dir, "out_zip2")

        fixed_epoch = 1704067200
        p1 = package_connector.package_connector(
            platform_key="windows-x64",
            binary_path=self.win_bin,
            output_dir=out_dir1,
            version="2.4.1",
            source_date_epoch=fixed_epoch,
        )
        p2 = package_connector.package_connector(
            platform_key="windows-x64",
            binary_path=self.win_bin,
            output_dir=out_dir2,
            version="2.4.1",
            source_date_epoch=fixed_epoch,
        )

        bytes1 = pathlib.Path(p1).read_bytes()
        bytes2 = pathlib.Path(p2).read_bytes()
        self.assertEqual(bytes1, bytes2)

        sha1 = package_connector.compute_sha256(p1)
        sha2 = package_connector.compute_sha256(p2)
        self.assertEqual(sha1, sha2)

        with zipfile.ZipFile(p1, "r") as zf:
            names = [zi.filename for zi in zf.infolist()]
            self.assertEqual(
                names,
                [
                    "ceo-connector-2.4.1/",
                    "ceo-connector-2.4.1/README.txt",
                    "ceo-connector-2.4.1/ceo-connector.exe",
                ],
            )
            # Check packaged README.txt contents in zip
            readme_data = zf.read("ceo-connector-2.4.1/README.txt").decode("utf-8")
            self.assertIn("ceo-connector run", readme_data)
            self.assertNotIn("ceo-connector daemon run", readme_data)

    def test_verify_archive_rejects_unexpected_files(self):
        dist_dir = os.path.join(self.temp_dir, "reject_test")
        archive = package_connector.package_connector(
            platform_key="linux-x64",
            binary_path=self.unix_bin,
            output_dir=dist_dir,
            version="2.4.1",
            source_date_epoch=1704067200,
        )

        # Create tampered archive with unauthorized file
        tampered_archive = os.path.join(self.temp_dir, "tampered.tar.gz")
        with open(tampered_archive, "wb") as f:
            with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0.0) as gz:
                with tarfile.open(mode="w", fileobj=gz) as tar:
                    with tarfile.open(archive, "r:gz") as orig_tar:
                        for m in orig_tar.getmembers():
                            tar.addfile(m, orig_tar.extractfile(m) if m.isfile() else None)

                    # Add illicit file
                    bad = tarfile.TarInfo("ceo-connector-2.4.1/credentials.json")
                    bad.type = tarfile.REGTYPE
                    bad.size = 14
                    bad.mode = 0o600
                    tar.addfile(bad, io.BytesIO(b'{"secret": 123}'))

        with self.assertRaises(ValueError) as ctx:
            package_connector.verify_archive(tampered_archive, "linux-x64", "2.4.1")
        self.assertIn("Unexpected file in archive", str(ctx.exception))

    def test_verify_archive_rejects_files_outside_top_dir(self):
        tampered_archive = os.path.join(self.temp_dir, "outside_dir.tar.gz")
        with open(tampered_archive, "wb") as f:
            with gzip.GzipFile(filename="", mode="wb", fileobj=f, mtime=0.0) as gz:
                with tarfile.open(mode="w", fileobj=gz) as tar:
                    ti = tarfile.TarInfo("outside.txt")
                    ti.type = tarfile.REGTYPE
                    ti.size = 5
                    ti.mode = 0o644
                    tar.addfile(ti, io.BytesIO(b"hello"))

        with self.assertRaises(ValueError) as ctx:
            package_connector.verify_archive(tampered_archive, "linux-x64", "2.4.1")
        self.assertIn("outside top-level directory", str(ctx.exception))

    def test_all_five_platforms_checksum_generation_and_verification(self):
        dist_dir = os.path.join(self.temp_dir, "dist_all")
        for plat, meta in package_connector.SUPPORTED_PLATFORMS.items():
            bin_path = self.win_bin if plat == "windows-x64" else self.unix_bin
            package_connector.package_connector(
                platform_key=plat,
                binary_path=bin_path,
                output_dir=dist_dir,
                version="2.4.1",
                source_date_epoch=1704067200,
            )

        # Generate checksums
        cksum_file = package_connector.generate_checksums(dist_dir)
        self.assertTrue(os.path.isfile(cksum_file))

        content = pathlib.Path(cksum_file).read_text(encoding="utf-8")
        lines = content.splitlines()
        self.assertEqual(len(lines), 5)

        # Assert deterministic alphabetical order
        assets = [line.split()[1] for line in lines]
        self.assertEqual(assets, package_connector.REQUIRED_ASSETS_ORDERED)

        # Verify checksums pass
        package_connector.verify_checksums(dist_dir, cksum_file)

        # Tampering with one file must fail verification
        target_asset = os.path.join(dist_dir, assets[0])
        with open(target_asset, "ab") as f:
            f.write(b"tamper")

        with self.assertRaises(ValueError) as ctx:
            package_connector.verify_checksums(dist_dir, cksum_file)
        self.assertIn("Checksum mismatch", str(ctx.exception))

    def test_resolve_tag_commit_and_rerun_identity_with_target_commitish_main(self):
        import subprocess
        repo_dir = os.path.join(self.temp_dir, "test_git_repo")
        os.makedirs(repo_dir)
        subprocess.run(["git", "init"], cwd=repo_dir, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_dir, check=True)
        subprocess.run(["git", "config", "user.name", "Test Runner"], cwd=repo_dir, check=True)
        dummy_file = os.path.join(repo_dir, "file.txt")
        pathlib.Path(dummy_file).write_text("hello")
        subprocess.run(["git", "add", "file.txt"], cwd=repo_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=repo_dir, check=True, capture_output=True)
        commit_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo_dir, check=True, capture_output=True, text=True
        ).stdout.strip().lower()

        # Create annotated tag
        subprocess.run(["git", "tag", "-a", "connector-v2.4.1", "-m", "Release 2.4.1"], cwd=repo_dir, check=True)

        # 1. Resolve tag commit
        resolved = package_connector.resolve_tag_commit("connector-v2.4.1", repo_root=repo_dir)
        self.assertEqual(resolved, commit_sha)

        # 2. Verify rerun identity succeeds even when target_commitish is "main"
        verified = package_connector.verify_rerun_identity(
            tag="connector-v2.4.1",
            expected_commit=commit_sha,
            release_target_commitish="main",
            repo_root=repo_dir,
        )
        self.assertEqual(verified, commit_sha)

        # 3. Verify rerun identity fails when expected_commit differs
        with self.assertRaises(ValueError) as ctx:
            package_connector.verify_rerun_identity(
                tag="connector-v2.4.1",
                expected_commit="0000000000000000000000000000000000000000",
                release_target_commitish="main",
                repo_root=repo_dir,
            )
        self.assertIn("mismatch", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
