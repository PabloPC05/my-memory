{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  git,
  git-lfs,
  poppler-utils,
}:

buildNpmPackage {
  pname = "my-memory";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../bin
      ../docs/agent-setup.md
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-mDNGdn9SA6FLLPjeTT0FQBspO2jREKKM16PxMCPH8M0=";
  npmBuildScript = "build";

  nativeBuildInputs = [ makeWrapper ];

  # git, git-lfs and pdftotext are called as programs; the wrapper puts the pinned ones first.
  postInstall = ''
    wrapProgram $out/bin/my-memory \
      --prefix PATH : ${
        lib.makeBinPath [
          git
          git-lfs
          poppler-utils
        ]
      }
  '';

  meta = {
    description = "Self-hosted, git-backed memory server for AI agents over MCP";
    license = lib.licenses.asl20;
    mainProgram = "my-memory";
    platforms = lib.platforms.linux;
  };
}
