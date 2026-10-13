self:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.arenaBlockExtension;
  system = pkgs.stdenv.hostPlatform.system;
  native = cfg.nativeHost;
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
    package = lib.mkOption {
      type = lib.types.package;
      default = if cfg.chromePublicKey == null then self.packages.${system}.browser-extension
        else self.packages.${system}.browser-extension.withChromePublicKey cfg.chromePublicKey;
      description = "Unpacked Chrome and Firefox extension bundles.";
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
    home.packages = [ cfg.package ];
    assertions = lib.optionals native.enable [
      { assertion = native.tokenEnvFile != null;
        message = "Arena Block native host requires a runtime tokenEnvFile."; }
      { assertion = native.chromeId == null || builtins.match "[a-p]{32}" native.chromeId != null;
        message = "Arena Block Chrome ID must be an exact 32-character extension ID."; }
    ];
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
