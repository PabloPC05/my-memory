self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    optional
    optionalAttrs
    ;
  cfg = config.services.my-memory;
  toml = pkgs.formats.toml { };

  listenType = types.submodule {
    options = {
      address = mkOption {
        type = types.str;
        default = "127.0.0.1";
      };
      port = mkOption { type = types.port; };
    };
  };

  # Secrets reach the service through systemd credentials; the config only names them.
  credentials =
    optional (cfg.remote != null && cfg.remote.tokenFile != null) "remote-token:${cfg.remote.tokenFile}"
    ++ optional (cfg.webhookSecretFile != null) "webhook-secret:${cfg.webhookSecretFile}"
    ++ optional (cfg.oauth != null) "oauth-client-id:${cfg.oauth.clientIdFile}"
    ++ optional (cfg.oauth != null) "oauth-client-secret:${cfg.oauth.clientSecretFile}";

  settings =
    {
      data_dir = "/var/lib/my-memory";
      inherit (cfg) branch;
      author_domain = cfg.authorDomain;
      fetch_interval_seconds = cfg.fetchIntervalSeconds;
      log_level = cfg.logLevel;
      pdftotext = "${pkgs.poppler-utils}/bin/pdftotext";
      listen =
        optionalAttrs (cfg.listen.public != null) { public = cfg.listen.public; }
        // optionalAttrs (cfg.listen.private != null) { private = cfg.listen.private; };
    }
    // optionalAttrs (cfg.publicUrl != null) { public_url = cfg.publicUrl; }
    // optionalAttrs (cfg.tokensFile != null) { tokens_file = cfg.tokensFile; }
    // optionalAttrs (cfg.webhookSecretFile != null) { webhook_secret_file = "credential:webhook-secret"; }
    // optionalAttrs (cfg.remote != null) {
      remote =
        {
          inherit (cfg.remote) url username;
        }
        // optionalAttrs (cfg.remote.tokenFile != null) { token_file = "credential:remote-token"; };
    }
    // optionalAttrs (cfg.oauth != null) {
      oauth = {
        forgejo_url = cfg.oauth.forgejoUrl;
        forgejo_internal_url = cfg.oauth.forgejoInternalUrl;
        client_id_file = "credential:oauth-client-id";
        client_secret_file = "credential:oauth-client-secret";
        allowed_users = cfg.oauth.allowedUsers;
        access_ttl_seconds = cfg.oauth.accessTtlSeconds;
        refresh_ttl_seconds = cfg.oauth.refreshTtlSeconds;
      };
    };

  configFile = toml.generate "my-memory.toml" settings;
in
{
  options.services.my-memory = {
    enable = mkEnableOption "my-memory, a git-backed memory server for AI agents (MCP)";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The my-memory package.";
    };

    branch = mkOption {
      type = types.str;
      default = "main";
    };

    authorDomain = mkOption {
      type = types.str;
      default = "my-memory.invalid";
      description = "Domain of commit author emails (<client-id>@<domain>).";
    };

    remote = mkOption {
      default = null;
      description = "Git remote of the notes repo (e.g. a Forgejo repo). Without it the repo stays local.";
      type = types.nullOr (
        types.submodule {
          options = {
            url = mkOption { type = types.str; };
            username = mkOption {
              type = types.str;
              default = "my-memory";
            };
            tokenFile = mkOption {
              type = types.nullOr types.str;
              default = null;
              description = "File with the remote password or access token (HTTP basic auth).";
            };
          };
        }
      );
    };

    listen = {
      public = mkOption {
        type = types.nullOr listenType;
        default = null;
        description = "Listener for the public reverse proxy: OAuth only.";
      };
      private = mkOption {
        type = types.nullOr listenType;
        default = null;
        description = "Listener for trusted networks: static tokens, uploads and the webhook.";
      };
    };

    publicUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "https://memory.example.com";
    };

    tokensFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        TOML file with static token hashes, managed with `my-memory token add|list|revoke --file <it>`.
        Read directly (not as a credential) so `systemctl reload my-memory` picks up changes; it must be
        readable by the my-memory group.
      '';
    };

    webhookSecretFile = mkOption {
      type = types.nullOr types.str;
      default = null;
    };

    oauth = mkOption {
      default = null;
      description = "OAuth for remote MCP clients (claude.ai), signing in with Forgejo.";
      type = types.nullOr (
        types.submodule {
          options = {
            forgejoUrl = mkOption {
              type = types.str;
              description = "Forgejo as the user's browser reaches it.";
            };
            forgejoInternalUrl = mkOption {
              type = types.str;
              description = "Forgejo as this server reaches it.";
            };
            clientIdFile = mkOption { type = types.str; };
            clientSecretFile = mkOption { type = types.str; };
            allowedUsers = mkOption { type = types.listOf types.str; };
            accessTtlSeconds = mkOption {
              type = types.int;
              default = 3600;
            };
            refreshTtlSeconds = mkOption {
              type = types.int;
              default = 2592000;
            };
          };
        }
      );
    };

    fetchIntervalSeconds = mkOption {
      type = types.int;
      default = 300;
      description = "Safety-net fetch from the remote, in case a webhook is missed. 0 disables it.";
    };

    logLevel = mkOption {
      type = types.enum [
        "debug"
        "info"
        "warn"
        "error"
      ];
      default = "info";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.listen.public != null || cfg.listen.private != null;
        message = "services.my-memory: set listen.public and/or listen.private";
      }
      {
        assertion = cfg.listen.public == null || (cfg.oauth != null && cfg.publicUrl != null);
        message = "services.my-memory: the public listener needs oauth and publicUrl";
      }
    ];

    users.users.my-memory = {
      isSystemUser = true;
      group = "my-memory";
      home = "/var/lib/my-memory";
    };
    users.groups.my-memory = { };

    environment.systemPackages = [ cfg.package ];
    environment.etc."my-memory/config.toml".source = configFile;

    systemd.services.my-memory = {
      description = "my-memory MCP server";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [
        "network-online.target"
      ] ++ optional config.services.forgejo.enable "forgejo.service";
      restartTriggers = [ configFile ];
      environment = {
        HOME = "/var/lib/my-memory";
        NODE_ENV = "production";
      };
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/my-memory serve --config ${configFile}";
        ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
        User = "my-memory";
        Group = "my-memory";
        StateDirectory = "my-memory";
        StateDirectoryMode = "0750";
        WorkingDirectory = "/var/lib/my-memory";
        LoadCredential = credentials;
        Restart = "on-failure";
        RestartSec = 5;
        UMask = "0027";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        CapabilityBoundingSet = "";
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        # V8's JIT needs writable+executable memory.
        MemoryDenyWriteExecute = false;
      };
    };
  };
}
