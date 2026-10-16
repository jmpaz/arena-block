#!/usr/bin/env python3
"""Deploy a Nix-built unpacked extension at a stable browser registration path."""
import argparse
import base64
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import uuid


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def fingerprint(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError(f"Unsupported extension file: {path}")
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def manifest(directory, extension_id):
    value = read_json(directory / "manifest.json")
    key = base64.b64decode(value.get("key", ""), validate=True)
    if not key:
        raise ValueError("A public manifest key is required to preserve the extension ID.")
    derived = "".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32])
    if derived != extension_id:
        raise ValueError("The extension public key does not match the configured ID.")
    return value


def compatible(before, after, extension_id):
    old = manifest(before, extension_id)
    new = manifest(after, extension_id)
    for value in (old, new):
        value.pop("version", None)
        value.pop("version_name", None)
    if old != new:
        raise ValueError("The manifest changes identity, permissions or browser configuration; review separately.")
    if (before / "oauth-client.json").read_bytes() != (after / "oauth-client.json").read_bytes():
        raise ValueError("The public OAuth configuration changed; review separately.")


def registered(profile, extension_id):
    found = []
    for filename in ("Secure Preferences", "Preferences"):
        path = profile / filename
        if path.is_file():
            value = read_json(path).get("extensions", {}).get("settings", {}).get(extension_id)
            if value:
                found.append(value)
    if len(found) > 1 and any(value != found[0] for value in found[1:]):
        raise ValueError("Chrome preference files disagree about the extension registration.")
    return found[0] if found else None


def default_user_data_directories():
    home = Path.home()
    return {home / "Library/Application Support/Google/Chrome",
        Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "google-chrome"}


def main_browser_running(profile):
    # SingletonLock appears after process startup. Check main processes as well
    # for the normal user-data directory. Do not inspect/export command lines.
    # A separate Chrome instance conservatively blocks normal-profile updates.
    if profile.parent not in default_user_data_directories():
        return False
    try:
        result = subprocess.run(["/bin/ps", "-axo", "uid=,comm="], check=True,
            capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        raise ValueError("Could not verify whether Chrome is running.") from None
    if not result.stdout.strip():
        raise ValueError("Could not verify whether Chrome is running.")
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or not re.fullmatch(r"-?\d+", fields[0]):
            raise ValueError("Could not verify whether Chrome is running.")
        if int(fields[0]) == os.getuid() and Path(fields[1]).name in {
                "Google Chrome", "google-chrome", "google-chrome-stable", "chrome"}:
            return True
    return False


def browser_running(profile):
    if main_browser_running(profile):
        return True
    lock = profile.parent / "SingletonLock"
    if not lock.is_symlink():
        return lock.exists()
    owner = str(lock.readlink())
    match = re.fullmatch(r"(.+)-(\d+)", owner)
    if not match or int(match[2]) < 1 or match[1].split(".")[0] != socket.gethostname().split(".")[0]:
        return True
    try:
        os.kill(int(match[2]), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def destination(path):
    if not path.is_absolute() or path == Path(path.anchor):
        raise ValueError("Choose an absolute extension directory.")
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError("The unpacked directory and its parents must be real directories.")
    if str(path).startswith("/nix/store/"):
        raise ValueError("An immutable Nix store registration needs a one-time move to a stable directory.")


def exchange(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = libc.renamex_np(os.fsencode(first), os.fsencode(second), 2)
    elif sys.platform.startswith("linux"):
        result = libc.renameat2(-100, os.fsencode(first), -100, os.fsencode(second), 2)
    else:
        raise ValueError("Atomic directory exchange is supported on macOS and Linux.")
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def status(args):
    entry = registered(args.profile, args.extension_id)
    state = read_json(args.state) if args.state.exists() else None
    present = args.directory.is_dir()
    return {
        "directory": str(args.directory),
        "extensionId": args.extension_id,
        "packageDirectory": str(args.package),
        "packageFingerprint": fingerprint(args.package),
        "packageRelease": read_json(args.package / "release.json") if (args.package / "release.json").exists() else None,
        "deployedFingerprint": fingerprint(args.directory) if present else None,
        "packageMatchesDirectory": present and fingerprint(args.directory) == fingerprint(args.package),
        "registeredPath": entry.get("path") if entry else None,
        "registeredAtDirectory": bool(entry and entry.get("location") == 4
            and entry.get("path") == str(args.directory)),
        "registrationRequired": not bool(entry and entry.get("location") == 4
            and entry.get("path") == str(args.directory)),
        "disableReasons": entry.get("disable_reasons", []) if entry else [],
        "browserRunning": browser_running(args.profile),
        "browserRuntimeVerified": False,
        "activation": "Use Chrome's Reload action after deployment, then verify the running extension separately.",
        "state": state,
    }


def deploy(args):
    destination(args.directory)
    manifest(args.package, args.extension_id)
    desired = fingerprint(args.package)
    entry = registered(args.profile, args.extension_id)
    pending_registration = not entry or entry.get("path") != str(args.directory)
    # A first unpacked load can be live before Chrome flushes registration.
    # Existing target files need protection even when that receipt is absent.
    protect_directory = not pending_registration or args.directory.exists()
    if entry and entry.get("location") != 4:
        raise ValueError("The existing extension is not an unpacked registration; review its installation separately.")
    if entry and pending_registration:
        if not args.prepare_for_migration:
            raise ValueError("The existing extension uses a different registration path; a one-time browser migration is required.")
        compatible(Path(entry["path"]), args.package, args.extension_id)
    if args.directory.exists():
        compatible(args.directory, args.package, args.extension_id)
        current = fingerprint(args.directory)
        if current == desired:
            return {"outcome": "unchanged", **status(args)}
        if args.state.exists():
            previous = read_json(args.state)
            if previous.get("directory") != str(args.directory) or previous.get("fingerprint") != current:
                raise ValueError("The managed directory changed outside the deployment tool.")
        elif not (args.adopt and entry and not pending_registration):
            raise ValueError("Adopting an existing directory requires --adopt and its matching browser registration.")
    if browser_running(args.profile) and protect_directory:
        if args.defer_if_running:
            return {"outcome": "deferred", "reason": "Close Chrome normally, then apply the Nix generation or run the configured update command.", **status(args)}
        raise ValueError("Chrome is running; close it normally before updating extension files.")
    args.directory.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="." + args.directory.name + "-stage-", dir=args.directory.parent))
    backup = None
    backup_fingerprint = None
    preserve_stage = False
    try:
        shutil.copytree(args.package, stage, dirs_exist_ok=True)
        stage.chmod(0o755)
        for path in stage.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        if fingerprint(stage) != desired:
            raise ValueError("The staged extension differs from its Nix package.")
        if browser_running(args.profile) and protect_directory:
            raise ValueError("Chrome started during staging; close it normally before updating.")
        if args.directory.exists():
            backup_fingerprint = fingerprint(args.directory)
            backup = args.directory.with_name("." + args.directory.name + "-backup-" + str(uuid.uuid4()))
            stage.rename(backup)
            stage = backup
            if browser_running(args.profile) and protect_directory:
                raise ValueError("Chrome started before replacement; close it normally before updating.")
            preserve_stage = True
            try:
                exchange(stage, args.directory)
            except OSError:
                preserve_stage = False
                raise
        else:
            stage.rename(args.directory)
        try:
            write_json(args.state, {"directory": str(args.directory), "fingerprint": desired,
                "package": str(args.package), "backup": str(backup) if backup else None,
                "backupFingerprint": backup_fingerprint})
        except Exception:
            if backup:
                try:
                    recovery_blocked = browser_running(args.profile) and protect_directory
                except ValueError:
                    raise OSError(f"Could not verify Chrome before receipt recovery. Previous files remain at {backup}; review before restoring.") from None
                if recovery_blocked:
                    raise OSError(f"Chrome started before receipt recovery. Previous files remain at {backup}; review before restoring.")
                try:
                    exchange(args.directory, backup)
                except OSError as error:
                    raise OSError(f"Could not restore the extension directory. Previous files remain at {backup}.") from error
                preserve_stage = False
            else:
                try:
                    recovery_blocked = browser_running(args.profile)
                except ValueError:
                    raise OSError(f"Could not verify Chrome before receipt recovery. New extension files remain at {args.directory}; review before removing.") from None
                if recovery_blocked:
                    raise OSError(f"Chrome started before receipt recovery. New extension files remain at {args.directory}; review before removing.")
                args.directory.rename(stage)
            raise
    finally:
        if stage.exists() and not preserve_stage:
            shutil.rmtree(stage)
    return {"outcome": "prepared" if pending_registration else "deployed", **status(args)}


def rollback(args):
    destination(args.directory)
    state = read_json(args.state)
    if state.get("directory") != str(args.directory) or state.get("fingerprint") != fingerprint(args.directory):
        raise ValueError("The managed directory changed outside the deployment tool.")
    backup = Path(state.get("backup") or "")
    if backup.parent != args.directory.parent or not backup.name.startswith("." + args.directory.name + "-backup-"):
        raise ValueError("No recorded extension backup is available.")
    destination(backup)
    compatible(args.directory, backup, args.extension_id)
    if fingerprint(backup) != state.get("backupFingerprint"):
        raise ValueError("The recorded backup changed outside the deployment tool.")
    if browser_running(args.profile):
        raise ValueError("Chrome is running; close it normally before rolling back.")
    exchange(args.directory, backup)
    try:
        write_json(args.state, {"directory": str(args.directory), "fingerprint": fingerprint(args.directory),
            "package": None, "backup": str(backup), "backupFingerprint": state["fingerprint"]})
    except OSError:
        try:
            recovery_blocked = browser_running(args.profile)
        except ValueError:
            raise OSError(f"Could not verify Chrome before receipt recovery. Both extension versions remain at {args.directory} and {backup}; review before restoring.") from None
        if recovery_blocked:
            raise OSError(f"Chrome started before receipt recovery. Both extension versions remain at {args.directory} and {backup}; review before restoring.") from None
        exchange(args.directory, backup)
        raise
    return {"outcome": "rolled-back", **status(args)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "deploy", "rollback"))
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--adopt", action="store_true")
    parser.add_argument("--prepare-for-migration", action="store_true")
    parser.add_argument("--defer-if-running", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("Use the exact 32-letter Chrome extension ID.")
    args.state = args.directory.with_name("." + args.directory.name + "-arena-block.json")
    try:
        if args.action == "status":
            result = status(args)
        else:
            destination(args.directory)
            args.directory.parent.mkdir(parents=True, exist_ok=True)
            lock = args.directory.with_name("." + args.directory.name + "-arena-block.lock")
            with lock.open("a") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = deploy(args) if args.action == "deploy" else rollback(args)
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, KeyError) as error:
        print(json.dumps({"outcome": "blocked", "error": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
