"""
Boundary and isolation verification tests for url-resolver.
Verifies no heavy dependencies loaded, no browser binaries in Dockerfile,
and zero browser processes.
"""

import os
import subprocess
import sys
import unittest

try:
    import psutil
except ImportError:
    psutil = None


def _count_browser_processes():
    if psutil is not None:
        return sum(1 for p in psutil.process_iter(['name']) if p.info['name'] and any(x in p.info['name'].lower() for x in ('chrome', 'chromium', 'playwright')))
    if os.path.exists("/proc"):
        count = 0
        for pid in os.listdir("/proc"):
            if pid.isdigit():
                try:
                    with open(os.path.join("/proc", pid, "comm"), "r") as f:
                        comm = f.read().lower()
                        if any(b in comm for b in ("chrome", "chromium", "playwright")):
                            count += 1
                except (FileNotFoundError, PermissionError):
                    pass
        return count
    return 0


URL_RESOLVER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestBoundaryIsolation(unittest.TestCase):
    def test_clean_process_import_isolation(self):
        """Verify importing url_resolver does NOT import heavy ML/ASR/Media libraries."""
        check_code = (
            "import sys; "
            "import url_resolver; "
            "heavy = ['torch', 'sherpa_onnx', 'faster_whisper', 'numpy', 'scipy', 'av']; "
            "loaded = [m for m in heavy if m in sys.modules]; "
            "assert not loaded, f'Heavy modules unexpectedly loaded: {loaded}'; "
            "print('ISOLATION_OK')"
        )
        proc = subprocess.run(
            [sys.executable, "-c", check_code],
            cwd=URL_RESOLVER_ROOT,
            capture_output=True,
            text=True,
            env=dict(os.environ, PYTHONPATH=os.path.join(URL_RESOLVER_ROOT, "src")),
        )
        self.assertEqual(proc.returncode, 0, f"Import isolation failed: {proc.stderr}")
        self.assertIn("ISOLATION_OK", proc.stdout)

    def test_dockerfile_no_browser_install_commands(self):
        """Verify Dockerfile strictly forbids browser binary downloads."""
        dockerfile_path = os.path.join(URL_RESOLVER_ROOT, "Dockerfile")
        self.assertTrue(os.path.exists(dockerfile_path))
        with open(dockerfile_path, "r", encoding="utf-8") as f:
            lines = [l.strip().lower() for l in f if not l.strip().startswith("#")]

        uncommented = " \n ".join(lines)
        self.assertNotIn("scrapling install", uncommented)
        self.assertNotIn("playwright install", uncommented)
        self.assertNotIn("patchright install", uncommented)
        self.assertNotIn("chromium-browser", uncommented)
        self.assertNotIn("chromium", uncommented)

    def test_zero_browser_processes_during_resolution(self):
        """Verify resolving URLs produces 0 browser processes."""
        from url_resolver import resolve_url
        from unittest.mock import patch, MagicMock

        procs_before = _count_browser_processes()
        
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.url = "https://example.com"
        mock_resp.html_content = "<html><head><meta property='og:title' content='Isolation Test'/></head><body>body content here</body></html>"
        mock_resp.headers = {}

        with patch("scrapling.fetchers.Fetcher.get", return_value=mock_resp):
            outcome = resolve_url("https://example.com")
            self.assertEqual(outcome.status, "resolved")

        procs_after = _count_browser_processes()
        self.assertEqual(procs_after - procs_before, 0, "Expected 0 new browser processes spawned")


if __name__ == "__main__":
    unittest.main()
