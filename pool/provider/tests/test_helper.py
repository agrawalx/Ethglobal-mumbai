import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("provider_helper", Path(__file__).resolve().parents[1] / "helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class ProviderHelperTests(unittest.TestCase):
    def test_operator_secrets_are_removed_before_any_subprocess(self):
        private = ["WORLD_RP_SIGNING_KEY", "JWT_SECRET", "HEDERA_OPERATOR_KEY", "TREASURY_PRIVATE_KEY", "ARKIV_PRIVATE_KEY", "PROVIDER_ARKIV_FUNDER_KEY"]
        with patch.dict(os.environ, {**{key: "test-only-value" for key in private}, "HF_TOKEN": "provider-owned-hub-token"}):
            helper.clean_environment()
            self.assertTrue(all(key not in os.environ for key in private))
            self.assertEqual(os.environ["HF_TOKEN"], "provider-owned-hub-token")
    def test_zip_rejects_traversal_and_symlinks(self):
        for path, symlink in (("../outside", False), ("key", True)):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                data = io.BytesIO()
                with zipfile.ZipFile(data, "w") as archive:
                    info = zipfile.ZipInfo(path)
                    if symlink: info.external_attr = 0o120777 << 16
                    archive.writestr(info, b"../../outside")
                with self.assertRaises(ValueError): helper.unzip(data.getvalue(), Path(directory) / "app")

    def test_model_transfer_checks_bytes_and_preserves_hf_offline_layout(self):
        content = b"model weight bytes"
        model = {"revision": "a" * 40, "files": {"model.safetensors": {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}}}
        config = {"snapshots": {"Qwen/test": model}, "coordinator_ip": "10.1.0.1", "lan_secret": "b" * 64}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(helper.urllib.request, "urlopen", return_value=io.BytesIO(content)):
                helper.download_from_pool(root, config, "Qwen/test", lambda *_: None)
            folder = root / "hf/hub/models--Qwen--test"
            self.assertEqual((folder / "refs/main").read_text(), "a" * 40)
            self.assertEqual((folder / "snapshots" / ("a" * 40) / "model.safetensors").read_bytes(), content)
            with patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("must reuse verified file")):
                helper.download_from_pool(root, config, "Qwen/test", lambda *_: None)

    def test_corrupt_transfer_is_not_promoted_and_signature_binds_file_and_nonce(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {"snapshots": {"Qwen/test": {"revision": "a" * 40, "files": {"model.safetensors": {"size": 3, "sha256": hashlib.sha256(b"abc").hexdigest()}}}},
                      "coordinator_ip": "10.1.0.1", "lan_secret": "b" * 64}
            with patch.object(helper.urllib.request, "urlopen", return_value=io.BytesIO(b"bad")):
                with self.assertRaisesRegex(RuntimeError, "integrity"):
                    helper.download_from_pool(Path(directory), config, "Qwen/test", lambda *_: None)
            self.assertFalse(list(Path(directory).rglob("*.partial")))
            self.assertFalse(list(Path(directory).rglob("model.safetensors")))
        first = helper.signature("b" * 64, "/file-a", "100", "a" * 32)
        self.assertNotEqual(first, helper.signature("b" * 64, "/file-b", "100", "a" * 32))
        self.assertNotEqual(first, helper.signature("b" * 64, "/file-a", "100", "c" * 32))

    def test_handoff_flat_cache_can_be_reused_without_modifying_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "existing"; source.mkdir()
            data = b"already downloaded model"; (source / "model.safetensors").write_bytes(data)
            destination = root / "new-cache/model.safetensors"
            self.assertTrue(helper.reuse_file([source], "model.safetensors", destination, {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual((source / "model.safetensors").read_bytes(), data)


    def test_relay_forwards_jobs_concurrently_with_one_poller(self):
        import threading, time
        stop, lock = threading.Event(), threading.Lock()
        queue, windows, polls = [{"id": "a"}, {"id": "b"}, {"id": "c"}], {}, []
        def poll():
            with lock:
                polls.append(time.monotonic())
                job = queue.pop(0) if queue else None
            if job is None: time.sleep(0.05)
            return job
        def forward(job):
            start = time.monotonic(); time.sleep(0.3)
            with lock:
                windows[job["id"]] = (start, time.monotonic())
                if len(windows) == 3: stop.set()
        thread = threading.Thread(target=helper.relay_loop, args=(stop, poll, forward, lambda _: None, 2), daemon=True)
        thread.start(); thread.join(3)
        self.assertEqual(set(windows), {"a", "b", "c"})
        (a0, a1), (b0, b1), (c0, _) = windows["a"], windows["b"], windows["c"]
        self.assertLess(max(a0, b0), min(a1, b1))   # a and b ran at the same time
        self.assertGreaterEqual(c0, min(a1, b1))    # c waited for a free worker (2 workers)

    def test_relay_keeps_polling_after_a_failed_job(self):
        import threading
        stop, seen = threading.Event(), []
        jobs = [{"id": "bad"}, {"id": "good"}]
        def forward(job):
            seen.append(job["id"])
            if job["id"] == "bad": raise RuntimeError("upstream failed")
            stop.set()
        logs = []
        helper.relay_loop(stop, lambda: jobs.pop(0) if jobs else None, forward, logs.append, 1)
        self.assertEqual(seen, ["bad", "good"])
        self.assertEqual(logs, ["Inference relay: upstream failed"])

if __name__ == "__main__": unittest.main()
