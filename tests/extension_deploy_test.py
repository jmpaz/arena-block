import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("extension_deploy", ROOT / "scripts/extension-deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
KEY = re.search(r'publicKey = "([^"]+)"', (ROOT / "nix/chrome-development-identity.nix").read_text())[1]
ID = "fijpffccadekllfkkfelnknanpljbobb"


class ExtensionDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.profile = self.root / "browser/Default"
        self.profile.mkdir(parents=True)
        self.directory = self.root / "stable/chrome"
        self.package = self.root / "package"
        self.package.mkdir()
        (self.package / "manifest.json").write_text(json.dumps({"key": KEY, "version": "0.1.0",
            "manifest_version": 3, "name": "Arena Block", "permissions": ["storage"]}))
        (self.package / "oauth-client.json").write_text('{"clientId":"public-client"}\n')
        (self.package / "background.js").write_text("const release = 1;\n")
        self.args = argparse.Namespace(package=self.package, directory=self.directory,
            profile=self.profile, extension_id=ID, adopt=False, defer_if_running=False,
            prepare_for_migration=False,
            state=self.directory.with_name(".chrome-arena-block.json"))

    def tearDown(self):
        self.temp.cleanup()

    def register(self, path=None):
        value = {"path": str(path or self.directory), "location": 4, "disable_reasons": [],
            "granted_permissions": {"api": ["storage"]}}
        (self.profile / "Secure Preferences").write_text(json.dumps({"extensions": {"settings": {ID: value}}}))

    def running_lock(self):
        (self.profile.parent / "SingletonLock").symlink_to(f"{socket.gethostname()}-{os.getpid()}")

    def test_update_and_rollback_keep_directory_registration_and_profile_bytes(self):
        self.assertEqual(deploy.deploy(self.args)["outcome"], "prepared")
        self.register()
        store = self.profile / "Local Extension Settings" / ID
        store.mkdir(parents=True)
        (store / "draft-and-token").write_bytes(b"opaque profile bytes")
        before = {p.relative_to(self.profile): p.read_bytes() for p in self.profile.rglob("*") if p.is_file()}
        (self.package / "background.js").write_text("const release = 2;\n")
        result = deploy.deploy(self.args)
        self.assertTrue(result["registeredAtDirectory"])
        self.assertTrue(result["packageMatchesDirectory"])
        self.assertFalse(result["browserRuntimeVerified"])
        self.assertFalse(self.directory.is_symlink())
        self.assertEqual(deploy.rollback(self.args)["outcome"], "rolled-back")
        self.assertEqual((self.directory / "background.js").read_text(), "const release = 1;\n")
        after = {p.relative_to(self.profile): p.read_bytes() for p in self.profile.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    def test_running_browser_defers_without_changing_extension_or_profile(self):
        deploy.deploy(self.args)
        self.register()
        before = deploy.fingerprint(self.directory)
        (self.package / "background.js").write_text("const release = 2;\n")
        self.running_lock()
        with self.assertRaisesRegex(ValueError, "Chrome is running"):
            deploy.deploy(self.args)
        self.args.defer_if_running = True
        self.assertEqual(deploy.deploy(self.args)["outcome"], "deferred")
        self.assertEqual(deploy.fingerprint(self.directory), before)

    def test_adoption_requires_existing_matching_registration(self):
        import shutil
        self.directory.parent.mkdir()
        shutil.copytree(self.package, self.directory)
        (self.package / "background.js").write_text("const release = 2;\n")
        self.args.adopt = True
        with self.assertRaisesRegex(ValueError, "matching browser registration"):
            deploy.deploy(self.args)
        self.register()
        self.assertEqual(deploy.deploy(self.args)["outcome"], "deployed")

    def test_different_registration_path_is_not_silently_changed(self):
        self.register(self.root / "another-release")
        self.args.adopt = True
        with self.assertRaisesRegex(ValueError, "one-time browser migration"):
            deploy.deploy(self.args)
        self.assertFalse(self.directory.exists())

    def test_manifest_and_oauth_changes_fail_before_writes(self):
        deploy.deploy(self.args)
        before = deploy.fingerprint(self.directory)
        manifest = deploy.read_json(self.package / "manifest.json")
        manifest["permissions"].append("tabs")
        deploy.write_json(self.package / "manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "permissions"):
            deploy.deploy(self.args)
        manifest["permissions"].remove("tabs")
        deploy.write_json(self.package / "manifest.json", manifest)
        (self.package / "oauth-client.json").write_text('{"clientId":"different"}\n')
        with self.assertRaisesRegex(ValueError, "OAuth"):
            deploy.deploy(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), before)

    def test_id_mismatch_fails_before_creating_directory(self):
        self.args.extension_id = "a" * 32
        with self.assertRaisesRegex(ValueError, "configured ID"):
            deploy.deploy(self.args)
        self.assertFalse(self.directory.exists())

    def test_symlink_and_store_destinations_are_refused(self):
        self.directory.parent.mkdir()
        self.directory.symlink_to(self.package, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "real directories"):
            deploy.deploy(self.args)
        with self.assertRaisesRegex(ValueError, "immutable Nix store"):
            deploy.destination(Path("/nix/store/example/chrome"))

    def test_external_modification_blocks_update_and_rollback(self):
        deploy.deploy(self.args)
        (self.directory / "background.js").write_text("unreviewed modification")
        with self.assertRaisesRegex(ValueError, "outside the deployment tool"):
            deploy.deploy(self.args)
        with self.assertRaisesRegex(ValueError, "outside the deployment tool"):
            deploy.rollback(self.args)

    def test_failed_receipt_write_restores_previous_directory(self):
        deploy.deploy(self.args)
        original = deploy.fingerprint(self.directory)
        (self.package / "background.js").write_text("const release = 2;\n")
        with patch.object(deploy, "write_json", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                deploy.deploy(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), original)
        self.assertEqual(deploy.read_json(self.args.state)["fingerprint"], original)

    def test_failed_backup_rename_keeps_previous_directory_and_receipt(self):
        deploy.deploy(self.args)
        original = deploy.fingerprint(self.directory)
        receipt = self.args.state.read_bytes()
        (self.package / "background.js").write_text("const release = 2;\n")
        rename = Path.rename

        def fail_backup(path, target):
            if Path(target).name.startswith(".chrome-backup-"):
                raise OSError("backup rename failed")
            return rename(path, target)

        with patch.object(Path, "rename", fail_backup):
            with self.assertRaisesRegex(OSError, "backup rename failed"):
                deploy.deploy(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), original)
        self.assertEqual(self.args.state.read_bytes(), receipt)

    def test_failed_exchange_keeps_previous_directory_and_receipt(self):
        deploy.deploy(self.args)
        original = deploy.fingerprint(self.directory)
        receipt = self.args.state.read_bytes()
        (self.package / "background.js").write_text("const release = 2;\n")
        with patch.object(deploy, "exchange", side_effect=OSError("exchange failed")):
            with self.assertRaisesRegex(OSError, "exchange failed"):
                deploy.deploy(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), original)
        self.assertEqual(self.args.state.read_bytes(), receipt)

    def test_failed_restoration_preserves_previous_files_for_recovery(self):
        deploy.deploy(self.args)
        original = deploy.fingerprint(self.directory)
        receipt = self.args.state.read_bytes()
        (self.package / "background.js").write_text("const release = 2;\n")
        exchange = deploy.exchange
        calls = 0

        def fail_restoration(first, second):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("restore failed")
            return exchange(first, second)

        with patch.object(deploy, "write_json", side_effect=OSError("disk full")), patch.object(deploy, "exchange", fail_restoration):
            with self.assertRaisesRegex(OSError, "Previous files remain at"):
                deploy.deploy(self.args)
        backups = list(self.directory.parent.glob(".chrome-backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(deploy.fingerprint(backups[0]), original)
        self.assertEqual(self.args.state.read_bytes(), receipt)

    def test_stale_same_host_lock_is_distinguished_from_unknown_lock(self):
        lock = self.profile.parent / "SingletonLock"
        lock.symlink_to(f"{socket.gethostname()}-999999999")
        self.assertFalse(deploy.browser_running(self.profile))
        lock.unlink()
        lock.symlink_to("another-computer-123")
        self.assertTrue(deploy.browser_running(self.profile))

    def test_modified_backup_is_not_restored(self):
        deploy.deploy(self.args)
        (self.package / "background.js").write_text("const release = 2;\n")
        deploy.deploy(self.args)
        backup = Path(deploy.read_json(self.args.state)["backup"])
        (backup / "background.js").write_text("unreviewed backup modification")
        with self.assertRaisesRegex(ValueError, "backup changed"):
            deploy.rollback(self.args)

    def test_browser_starting_during_staging_prevents_exchange(self):
        deploy.deploy(self.args)
        self.register()
        original = deploy.fingerprint(self.directory)
        (self.package / "background.js").write_text("const release = 2;\n")
        with patch.object(deploy, "browser_running", side_effect=[False, True]):
            with self.assertRaisesRegex(ValueError, "started during staging"):
                deploy.deploy(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), original)

    def test_store_registration_can_prepare_stable_files_without_install_claim(self):
        import shutil
        old = self.root / "immutable-generation/chrome"
        old.parent.mkdir()
        shutil.copytree(self.package, old)
        self.register(old)
        preferences = (self.profile / "Secure Preferences").read_bytes()
        self.running_lock()
        self.args.prepare_for_migration = True
        result = deploy.deploy(self.args)
        self.assertEqual(result["outcome"], "prepared")
        self.assertTrue(result["registrationRequired"])
        self.assertFalse(result["registeredAtDirectory"])
        self.assertFalse(result["browserRuntimeVerified"])
        self.assertEqual((self.profile / "Secure Preferences").read_bytes(), preferences)

    def test_failed_rollback_receipt_restores_current_directory(self):
        deploy.deploy(self.args)
        (self.package / "background.js").write_text("const release = 2;\n")
        deploy.deploy(self.args)
        current = deploy.fingerprint(self.directory)
        with patch.object(deploy, "write_json", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                deploy.rollback(self.args)
        self.assertEqual(deploy.fingerprint(self.directory), current)
        self.assertEqual(deploy.read_json(self.args.state)["fingerprint"], current)


if __name__ == "__main__":
    unittest.main()
