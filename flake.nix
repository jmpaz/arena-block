{
  description = "Intentional social-post composition for Are.na";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        metadata = builtins.fromJSON (builtins.readFile ./package.json);
        source = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            let base = baseNameOf path;
            in !(base == ".git" || base == "node_modules" || base == "result" || base == "dist" || base == ".build" || base == "DerivedData" || base == ".swiftpm" || base == "Local.xcconfig" || base == ".DS_Store" || base == "__pycache__"
              || pkgs.lib.hasSuffix ".xcodeproj" base || pkgs.lib.hasSuffix ".xcworkspace" base);
        };
        nodeModulesHash = {
          x86_64-linux = "sha256-/NKSU8rYaYvNBFcE9ty1UXSvYBo3FEfvR9RTnWvgUFk=";
          aarch64-darwin = "sha256-KNzmEJx1QXfU5bk8Jot7T46HEwjSXoD8EEEOOlKZAcU=";
        }.${system};
        nodeModules = pkgs.stdenvNoCC.mkDerivation {
          pname = "arena-block-node-modules";
          version = metadata.version;
          src = source;
          nativeBuildInputs = [ pkgs.bun pkgs.writableTmpDirAsHomeHook ];
          dontConfigure = true;
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
            bun install --frozen-lockfile --ignore-scripts --no-cache --no-progress
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p "$out"
            cp -R node_modules "$out/"
            runHook postInstall
          '';
          outputHash = nodeModulesHash;
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
        };
        arenaBlock = pkgs.stdenvNoCC.mkDerivation {
          pname = "arena-block";
          version = metadata.version;
          src = source;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            app="$out/lib/arena-block"
            mkdir -p "$app" "$out/bin"
            cp -R . "$app/"
            cp ${pkgs.writeText "arena-block-build-info.json" (builtins.toJSON {
              version = metadata.version;
              revision = self.rev or (self.dirtyRev or null);
              sourceId = builtins.hashString "sha256" (toString source);
              platform = system;
              schemaVersion = 1;
            })} "$app/build-info.json"
            ln -s ${nodeModules}/node_modules "$app/node_modules"
            makeWrapper ${pkgs.bun}/bin/bun "$out/bin/arena-block" \
              --add-flags "$app/src/cli.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg pkgs.yt-dlp ]}
            runHook postInstall
          '';
          meta.mainProgram = "arena-block";
        };
        browserExtension = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "arena-block-browser-extension";
          version = metadata.version;
          src = source;
          ARENA_BLOCK_SUBSTACK_TAB_READING = "true";
          passthru.withChromePublicKey = chromePublicKey:
            browserExtension.overrideAttrs (_: {
              ARENA_BLOCK_CHROME_PUBLIC_KEY = chromePublicKey;
            });
          passthru.withBrowserConfig = { chromePublicKey, oauthClientId ? "", substackTabReading ? true }:
            browserExtension.overrideAttrs (_: {
              ARENA_BLOCK_CHROME_PUBLIC_KEY = chromePublicKey;
              ARENA_BLOCK_OAUTH_CLIENT_ID = oauthClientId;
              ARENA_BLOCK_SUBSTACK_TAB_READING = pkgs.lib.boolToString substackTabReading;
            });
          nativeBuildInputs = [ pkgs.bun pkgs.zip ];
          buildPhase = ''
            runHook preBuild
            ln -s ${nodeModules}/node_modules node_modules
            bun run extension:build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            target="$out/share/arena-block-extension"
            mkdir -p "$target"
            cp -R extension/dist/chrome extension/dist/firefox "$target/"
            cp ${pkgs.writeText "arena-block-extension-release.json" (builtins.toJSON {
              version = metadata.version;
              revision = self.rev or (self.dirtyRev or null);
              sourceId = builtins.hashString "sha256" (toString source);
              features.substackTabReading = finalAttrs.ARENA_BLOCK_SUBSTACK_TAB_READING == "true";
            })} "$target/chrome/release.json"
            cp "$target/chrome/release.json" "$target/firefox/release.json"
            find "$target/chrome" "$target/firefox" -type f -exec touch -t 198001010000.00 {} +
            (cd "$target/chrome" && find . -type f -print | LC_ALL=C sort | zip -q -X "$target/chrome.zip" -@)
            (cd "$target/firefox" && find . -type f -print | LC_ALL=C sort | zip -q -X "$target/firefox-unsigned.zip" -@)
            runHook postInstall
          '';
        });
        extensionManager = pkgs.writeShellScriptBin "arena-block-extension-manage" ''
          exec ${pkgs.python3}/bin/python3 ${./scripts/extension-deploy.py} "$@"
        '';
      in {
        packages = {
          default = arenaBlock;
          arena-block = arenaBlock;
          node-modules = nodeModules;
          browser-extension = browserExtension;
          extension-manager = extensionManager;
        };
        apps.default = {
          type = "app";
          program = "${arenaBlock}/bin/arena-block";
        };
        checks.default = pkgs.runCommand "arena-block-check" {
          nativeBuildInputs = [ pkgs.bun pkgs.typescript pkgs.ffmpeg arenaBlock ];
        } ''
          cp -R ${source} source
          chmod -R u+w source
          ln -s ${nodeModules}/node_modules source/node_modules
          cd source
          ${pkgs.typescript}/bin/tsc --noEmit
          bun test --max-concurrency=4 --timeout=30000
          arena-block --help >/dev/null
          arena-block version >/dev/null
          touch "$out"
        '';
        checks.extension-deployment = pkgs.runCommand "arena-block-extension-deployment-check" {
          nativeBuildInputs = [ pkgs.python3 ];
        } ''
          cp -R ${source} source
          chmod -R u+w source
          cd source
          python3 -m unittest discover -s tests -p 'extension_deploy_test.py'
          touch "$out"
        '';
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.ffmpeg pkgs.typescript pkgs.yt-dlp ];
        };
      }) // {
        lib.chromeDevelopmentIdentity = import ./nix/chrome-development-identity.nix;
        homeManagerModules.default = import ./nix/home-manager.nix self;
        homeManagerModules.browser-extension = import ./nix/extension-home-manager.nix self;
      };
}
