"""Hermetic CLI regressions: codesign is a metadata fixture, never Apple's tool."""
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VERIFIER = Path(os.environ.get("CAPTURE_SIGNING_VERIFIER", Path(__file__).resolve().parents[1] / "verify-signing.py"))

class SigningVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capture-signing-test-")
        self.root = Path(self.temp.name)
        self.app = self.root / "Capture.app"
        self.share = self.app / "PlugIns" / "CaptureShare.appex"
        self.bundle(self.app, "org.fixture.capture")
        self.bundle(self.share, "org.fixture.capture.share", share=True)
        bin = self.root / "bin"; bin.mkdir()
        fake = bin / "codesign"
        fake.write_text("#!/usr/bin/env python3\nimport sys\nfrom pathlib import Path\nb=Path(sys.argv[-1])\nif '--verify' in sys.argv:sys.exit(1 if (b/'.fixture-invalid-signature').exists() else 0)\nsys.stdout.buffer.write((b/'fixture-entitlements.plist').read_bytes())\n")
        fake.chmod(0o755)
        self.env = dict(os.environ)
        self.env["PATH"] = str(bin) + os.pathsep + self.env.get("PATH", "")

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, path, identifier, share=False):
        path.mkdir(parents=True)
        info = {"CFBundleIdentifier": identifier, "CaptureAppGroup": "group.fixture.shared", "CaptureKeychainGroup": "FIXTURE.capture.shared"}
        if share: info["NSExtension"] = {"NSExtensionPointIdentifier": "com.apple.share-services"}
        ent = {"com.apple.security.application-groups": ["group.fixture.shared"], "keychain-access-groups": ["FIXTURE.capture.shared"]}
        self.write(path / "Info.plist", info); self.write(path / "fixture-entitlements.plist", ent)

    def write(self, path, value): path.write_bytes(plistlib.dumps(value))
    def change(self, path, key, value):
        data = plistlib.loads(path.read_bytes()); data[key] = value; self.write(path, data)
    def run_verifier(self):
        return subprocess.run([sys.executable, str(VERIFIER), str(self.app)], env=self.env, capture_output=True, text=True, timeout=10)
    def rejected(self, message=None):
        result = self.run_verifier()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        if message: self.assertIn(message, result.stderr)

    def test_matching_app_and_share_are_accepted(self):
        result = self.run_verifier(); self.assertEqual(result.returncode, 0, result.stderr)
    def test_missing_share_is_rejected(self):
        import shutil
        shutil.rmtree(self.app / "PlugIns"); self.rejected()
    def test_different_app_groups_are_rejected(self):
        self.change(self.share / "Info.plist", "CaptureAppGroup", "group.fixture.other")
        self.change(self.share / "fixture-entitlements.plist", "com.apple.security.application-groups", ["group.fixture.other"])
        self.rejected()
    def test_different_keychain_groups_are_rejected(self):
        self.change(self.share / "Info.plist", "CaptureKeychainGroup", "FIXTURE.other.shared")
        self.change(self.share / "fixture-entitlements.plist", "keychain-access-groups", ["FIXTURE.other.shared"])
        self.rejected()
    def test_other_extension_does_not_replace_share(self):
        self.change(self.share / "Info.plist", "NSExtension", {"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"})
        self.rejected()
    def test_multiple_share_extensions_are_rejected(self):
        self.bundle(self.app / "PlugIns" / "OtherShare.appex", "org.fixture.capture.share", share=True); self.rejected()
    def test_wrong_share_bundle_id_is_rejected(self):
        self.change(self.share / "Info.plist", "CFBundleIdentifier", "org.fixture.other.share"); self.rejected()
    def test_missing_app_identifier_is_rejected(self):
        data = plistlib.loads((self.app / "Info.plist").read_bytes()); del data["CFBundleIdentifier"]
        self.write(self.app / "Info.plist", data); self.rejected()
    def test_empty_runtime_app_group_is_rejected(self):
        self.change(self.share / "Info.plist", "CaptureAppGroup", "")
        self.change(self.share / "fixture-entitlements.plist", "com.apple.security.application-groups", [""])
        self.rejected()
    def test_empty_runtime_keychain_group_is_rejected(self):
        self.change(self.share / "Info.plist", "CaptureKeychainGroup", "")
        self.change(self.share / "fixture-entitlements.plist", "keychain-access-groups", [""])
        self.rejected()
    def test_unresolved_runtime_app_group_is_rejected(self):
        value = "$(CAPTURE_APP_GROUP)"
        self.change(self.share / "Info.plist", "CaptureAppGroup", value)
        self.change(self.share / "fixture-entitlements.plist", "com.apple.security.application-groups", [value]); self.rejected()
    def test_unresolved_runtime_keychain_group_is_rejected(self):
        value = "$(AppIdentifierPrefix)fixture.shared"
        self.change(self.share / "Info.plist", "CaptureKeychainGroup", value)
        self.change(self.share / "fixture-entitlements.plist", "keychain-access-groups", [value]); self.rejected()
    def test_runtime_app_group_must_be_signed(self):
        self.change(self.share / "fixture-entitlements.plist", "com.apple.security.application-groups", ["group.fixture.other"]); self.rejected()
    def test_runtime_keychain_group_must_be_signed(self):
        self.change(self.share / "fixture-entitlements.plist", "keychain-access-groups", ["FIXTURE.other.shared"]); self.rejected()
    def test_app_group_entitlement_must_be_an_array(self):
        self.change(self.share / "fixture-entitlements.plist", "com.apple.security.application-groups", "group.fixture.shared"); self.rejected()
    def test_keychain_entitlement_must_be_an_array(self):
        self.change(self.share / "fixture-entitlements.plist", "keychain-access-groups", "FIXTURE.capture.shared"); self.rejected()
    def test_signature_failure_is_not_ignored(self):
        (self.share / ".fixture-invalid-signature").touch(); self.rejected()
    def test_usage_has_explicit_exit_status(self):
        result = subprocess.run([sys.executable, str(VERIFIER)], env=self.env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)

if __name__ == "__main__": unittest.main()
