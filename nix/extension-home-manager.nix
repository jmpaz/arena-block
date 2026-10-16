self:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.arenaBlockExtension;
  system = pkgs.stdenv.hostPlatform.system;
  native = cfg.nativeHost;
  chrome = cfg.chrome;
  updater = pkgs.writeShellScriptBin "arena-block-extension-update" ''
    exec ${self.packages.${system}.extension-manager}/bin/arena-block-extension-manage "$@" \
      --package ${lib.escapeShellArg "${cfg.package}/share/arena-block-extension/chrome"} \
      --directory ${lib.escapeShellArg chrome.directory} \
      --profile ${lib.escapeShellArg chrome.profileDirectory} \
      --extension-id ${lib.escapeShellArg (if chrome.extensionId == null then "" else chrome.extensionId)} \
      ${lib.optionalString chrome.prepareForMigration "--prepare-for-migration"} \
      ${lib.optionalString chrome.adoptExisting "--adopt"}
  '';
  name = "net.fjpaz.arena_block";
  launcher = pkgs.writeShellScriptBin "arena-block-native-host" ''
    unset ARENA_BLOCK_ACCESS_TOKEN
    env_file=${lib.escapeShellArg (if native.tokenEnvFile == null then "" else native.tokenEnvFile)}
    if [ -r "$env_file" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
          export\ ARENA_BLOCK_ACCESS_TOKEN=*)
            value="''${line#export ARENA_BLOCK_ACCESS_TOKEN=}"
            break
            ;;
          ARENA_BLOCK_ACCESS_TOKEN=*)
            value="''${line#ARENA_BLOCK_ACCESS_TOKEN=}"
            break
            ;;
        esac
      done < "$env_file"
      case "$value" in
        \"*\") value="''${value#\"}"; value="''${value%\"}" ;;
        \'*\') value="''${value#\'}"; value="''${value%\'}" ;;
      esac
      export ARENA_BLOCK_ACCESS_TOKEN="$value"
    fi
    export ARENA_BLOCK_ENDPOINT=${lib.escapeShellArg native.endpoint}
    exec ${pkgs.bun}/bin/bun ${native.corePackage}/lib/arena-block/extension/native-host.ts
  '';
  manifest = browser: pkgs.writeText "${name}-${browser}.json" (builtins.toJSON ({
    inherit name;
    description = "Arena Block save bridge";
    path = "${launcher}/bin/arena-block-native-host";
    type = "stdio";
  } // (if browser == "firefox" then {
    allowed_extensions = [ "arena-block@fjpaz.net" ];
  } else {
    allowed_origins = [ "chrome-extension://${native.chromeId}/" ];
  })));
in {
  options.programs.arenaBlockExtension = {
    enable = lib.mkEnableOption "Arena Block browser extension package";
    chromePublicKey = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Public manifest key for a stable unpacked Chrome development ID; safe to keep in Nix configuration.";
    };
    oauthClientId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Existing public OAuth client ID embedded in browser builds; never a client secret or access token.";
    };
    substackTabReading = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Declare optional scripting for Substack tab reading. Disabling this retains public URL acquisition and marks tab reading unavailable; it does not request or grant permissions.";
    };
    permissionProfile = lib.mkOption {
      type = lib.types.enum [ "legacy" "named-sources" ];
      default = "legacy";
      description = "Optional host declaration: named-sources lists supported source APIs and configured Mastodon instances. This changes the manifest and requires separate installation review; it grants no browser access.";
    };
    mastodonOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Exact HTTPS Mastodon origins available for optional consent. Setup requests only instances in the current capture. Other instances require the local helper or a package rebuild.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.browser-extension.withBrowserConfig {
          chromePublicKey = if cfg.chromePublicKey == null then "" else cfg.chromePublicKey;
          oauthClientId = cfg.oauthClientId;
          substackTabReading = cfg.substackTabReading;
          permissionProfile = cfg.permissionProfile;
          mastodonOrigins = cfg.mastodonOrigins;
        };
      description = "Unpacked Chrome and Firefox extension bundles.";
    };
    chrome = {
      enable = lib.mkEnableOption "Nix-managed files for an unpacked Chrome extension";
      directory = lib.mkOption {
        type = lib.types.str;
        default = "${config.home.homeDirectory}/.local/share/arena-block-extension/unpacked-chrome";
        description = "Stable real directory loaded by Chrome. Set the existing registered real directory when adopting a local installation.";
      };
      profileDirectory = lib.mkOption {
        type = lib.types.str;
        default = if pkgs.stdenv.isDarwin
          then "${config.home.homeDirectory}/Library/Application Support/Google/Chrome/Default"
          else "${config.xdg.configHome}/google-chrome/Default";
        description = "Existing Chrome profile used for read-only registration and running-browser checks.";
      };
      extensionId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = native.chromeId;
        description = "Exact existing extension ID derived from chromePublicKey.";
      };
      adoptExisting = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Allow adoption of an existing real directory only when Chrome already registers that directory with the same identity and configuration.";
      };
      prepareForMigration = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Prepare the stable directory when Chrome registers a different unpacked path, preserving identity and configuration. Report the required one-time browser registration separately.";
      };
    };
    nativeHost = {
      enable = lib.mkEnableOption "optional Arena Block native messaging host";
      corePackage = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${system}.default;
      };
      endpoint = lib.mkOption {
        type = lib.types.str;
        default = "http://127.0.0.1:8790";
      };
      tokenEnvFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Runtime private env file containing ARENA_BLOCK_ACCESS_TOKEN; never a Nix store secret.";
      };
      chromeId = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Exact Chrome extension ID allowed to call this host.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ] ++ lib.optional chrome.enable updater;
    assertions = lib.optionals chrome.enable [
      { assertion = cfg.chromePublicKey != null;
        message = "A stable Chrome deployment requires chromePublicKey."; }
      { assertion = chrome.extensionId != null && builtins.match "[a-p]{32}" chrome.extensionId != null;
        message = "A stable Chrome deployment requires the exact extensionId."; }
      { assertion = !native.enable || native.chromeId == null || native.chromeId == chrome.extensionId;
        message = "The managed Chrome extension ID must match the native host allowlist."; }
    ] ++ lib.optionals native.enable [
      { assertion = native.tokenEnvFile != null;
        message = "Arena Block native host requires a runtime tokenEnvFile."; }
      { assertion = native.chromeId == null || builtins.match "[a-p]{32}" native.chromeId != null;
        message = "Arena Block Chrome ID must be an exact 32-character extension ID."; }
    ];
    home.activation.arenaBlockExtension = lib.mkIf chrome.enable (lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run ${updater}/bin/arena-block-extension-update deploy --defer-if-running
    '');
    home.file = lib.optionalAttrs native.enable ({
      ${if pkgs.stdenv.isDarwin then "Library/Application Support/Mozilla/NativeMessagingHosts/${name}.json" else ".mozilla/native-messaging-hosts/${name}.json"}.source = manifest "firefox";
    } // lib.optionalAttrs (native.chromeId != null) (if pkgs.stdenv.isDarwin then {
      "Library/Application Support/Google/Chrome/NativeMessagingHosts/${name}.json".source = manifest "chrome";
    } else {
      ".config/google-chrome/NativeMessagingHosts/${name}.json".source = manifest "chrome";
      ".config/chromium/NativeMessagingHosts/${name}.json".source = manifest "chrome";
    }));
  };
}
