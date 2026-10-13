"""Verify signatures and the app/Share extension's actual shared access groups."""

import plistlib
import subprocess
import sys
from pathlib import Path


class SigningConfigurationError(ValueError):
    pass


def access_groups(info, entitlements, name):
    keychain = info.get("CaptureKeychainGroup")
    group = info.get("CaptureAppGroup")
    for label, value in [("Keychain", keychain), ("App Group", group)]:
        if not isinstance(value, str) or not value or "$" in value or "*" in value:
            raise SigningConfigurationError(f"{name}: runtime {label} is empty or unresolved")
    signed_keychains = entitlements.get("keychain-access-groups")
    signed_groups = entitlements.get("com.apple.security.application-groups")
    if not isinstance(signed_keychains, list) or keychain not in signed_keychains:
        raise SigningConfigurationError(f"{name}: runtime Keychain group does not match signing entitlements")
    if not isinstance(signed_groups, list) or group not in signed_groups:
        raise SigningConfigurationError(f"{name}: runtime App Group does not match signing entitlements")
    return group, keychain


def validate_configuration(app_info, app_entitlements, extensions):
    """Metadata checks; this function does not sign, provision, or access Keychain."""
    app_groups = access_groups(app_info, app_entitlements, "Capture.app")
    shares = []
    for name, info, entitlements in extensions:
        groups = access_groups(info, entitlements, name)
        extension = info.get("NSExtension")
        if isinstance(extension, dict) and extension.get("NSExtensionPointIdentifier") == "com.apple.share-services":
            shares.append((name, info, groups))
    if len(shares) != 1:
        raise SigningConfigurationError("Capture.app: exactly one Share extension is required")
    name, share_info, share_groups = shares[0]
    identifier = app_info.get("CFBundleIdentifier")
    if not isinstance(identifier, str) or not identifier or share_info.get("CFBundleIdentifier") != identifier + ".share":
        raise SigningConfigurationError(f"{name}: bundle identifier does not match the app's .share identifier")
    if share_groups[0] != app_groups[0]:
        raise SigningConfigurationError(f"{name}: app and Share extension use different App Groups")
    if share_groups[1] != app_groups[1]:
        raise SigningConfigurationError(f"{name}: app and Share extension use different Keychain groups")


def signed_metadata(bundle):
    subprocess.run(["codesign", "--verify", "--strict", str(bundle)], check=True)
    result = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(bundle)], check=True, capture_output=True)
    return plistlib.loads((bundle / "Info.plist").read_bytes()), plistlib.loads(result.stdout)


def verify_app(app):
    app_info, app_entitlements = signed_metadata(app)
    extensions = []
    for bundle in sorted((app / "PlugIns").glob("*.appex")):
        info, entitlements = signed_metadata(bundle)
        extensions.append((bundle.name, info, entitlements))
    validate_configuration(app_info, app_entitlements, extensions)
    print(f"{app.name}: signatures, runtime access groups and Share configuration match")


def main(argv):
    if len(argv) != 2:
        print("Usage: verify-signing.py Capture.app", file=sys.stderr)
        return 2
    try:
        verify_app(Path(argv[1]))
    except (SigningConfigurationError, OSError, plistlib.InvalidFileException, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
