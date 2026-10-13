self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.arenaBlock;
  stateDirectory = if cfg.stateDirectory != null
    then cfg.stateDirectory
    else "${config.home.homeDirectory}/.local/share/arena-block";
  mediaDirectory = if cfg.mediaDirectory != null
    then cfg.mediaDirectory
    else "${stateDirectory}/media";
in
{
  options.services.arenaBlock = {
    enable = lib.mkEnableOption "arena-block service";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Package providing the arena-block executable.";
    };
    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8790;
    };
    publicBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8790";
    };
    stateDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
    };
    mediaDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
    };
    defaultChannels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
    };
    credentialsFiles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
    };
    mcpPublishing = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Explicitly expose private MCP save/status/cancel through the existing owner daemon.";
    };
    credentialConfigFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Existing credential profile/environment-reference/account configuration; never a token value.";
    };
    provenancePolicyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Explicit private Inbox metadata policy; absent by default.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    systemd.user.services.arena-block = {
      Unit = {
        Description = "Compose and publish intentional Are.na blocks";
        After = [ "network-online.target" "agenix.service" ];
        Wants = [ "network-online.target" "agenix.service" ];
      };
      Service = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/arena-block serve";
        EnvironmentFile = cfg.credentialsFiles;
        Environment = [
          "ARENA_BLOCK_HOST=${cfg.host}"
          "ARENA_BLOCK_PORT=${toString cfg.port}"
          "ARENA_BLOCK_PUBLIC_BASE_URL=${cfg.publicBaseUrl}"
          "ARENA_BLOCK_STATE_DIR=${stateDirectory}"
          "ARENA_BLOCK_MEDIA_DIR=${mediaDirectory}"
          "ARENA_BLOCK_DEFAULT_CHANNELS=${lib.concatStringsSep "," cfg.defaultChannels}"
          "ARENA_BLOCK_ENDPOINT=http://${cfg.host}:${toString cfg.port}"
          "ARENA_BLOCK_MCP_PUBLISHING=${if cfg.mcpPublishing then "1" else "0"}"
        ] ++ lib.optional (cfg.credentialConfigFile != null) "ARENA_BLOCK_CREDENTIAL_CONFIG=${cfg.credentialConfigFile}"
          ++ lib.optional (cfg.provenancePolicyFile != null) "ARENA_BLOCK_PROVENANCE_POLICY=${cfg.provenancePolicyFile}";
        Restart = "on-failure";
        RestartSec = "5s";
        UMask = "0077";
        StandardOutput = "journal";
        StandardError = "journal";
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
