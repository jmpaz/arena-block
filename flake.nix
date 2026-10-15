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
            in !(base == ".git" || base == "node_modules" || base == "result" || base == "dist" || base == ".build" || base == "DerivedData" || base == ".swiftpm" || base == "Local.xcconfig" || base == ".DS_Store"
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
        publicBrowserHelper = if pkgs.stdenv.isDarwin then pkgs.stdenv.mkDerivation {
          pname = "arena-block-public-browser";
          version = metadata.version;
          src = source;
          nativeBuildInputs = [ pkgs.swift ];
          buildInputs = [ pkgs.apple-sdk ];
          buildPhase = ''
            runHook preBuild
            swiftc -swift-version 5 -O -module-cache-path "$TMPDIR/swift-module-cache" \
              ios/Sources/CaptureRuntime/RedditPublicPageAcquirer.swift \
              ios/scripts/reddit-public-browser-cli.swift -o arena-block-public-browser
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm755 arena-block-public-browser "$out/bin/arena-block-public-browser"
            runHook postInstall
          '';
        } else null;
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
            ${pkgs.lib.optionalString pkgs.stdenv.isDarwin ''
              mkdir -p "$app/libexec"
              ln -s ${publicBrowserHelper}/bin/arena-block-public-browser "$app/libexec/arena-block-public-browser"
            ''}
            makeWrapper ${pkgs.bun}/bin/bun "$out/bin/arena-block" \
              --add-flags "$app/src/cli.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg pkgs.yt-dlp ]}
            runHook postInstall
          '';
          meta.mainProgram = "arena-block";
        };
        browserExtension = pkgs.stdenvNoCC.mkDerivation {
          pname = "arena-block-browser-extension";
          version = metadata.version;
          src = source;
          passthru.withChromePublicKey = chromePublicKey:
            browserExtension.overrideAttrs (_: {
              ARENA_BLOCK_CHROME_PUBLIC_KEY = chromePublicKey;
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
            find "$target/chrome" "$target/firefox" -type f -exec touch -t 198001010000.00 {} +
            (cd "$target/chrome" && find . -type f -print | LC_ALL=C sort | zip -q -X "$target/chrome.zip" -@)
            (cd "$target/firefox" && find . -type f -print | LC_ALL=C sort | zip -q -X "$target/firefox-unsigned.zip" -@)
            runHook postInstall
          '';
        };
      in {
        packages = {
          default = arenaBlock;
          arena-block = arenaBlock;
          node-modules = nodeModules;
          browser-extension = browserExtension;
        } // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
          public-browser-helper = publicBrowserHelper;
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
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.ffmpeg pkgs.typescript pkgs.yt-dlp ];
        };
      }) // {
        lib.chromeDevelopmentIdentity = import ./nix/chrome-development-identity.nix;
        homeManagerModules.default = import ./nix/home-manager.nix self;
        homeManagerModules.browser-extension = import ./nix/extension-home-manager.nix self;
      };
}
