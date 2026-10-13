Bun.plugin({
  name: "deny-eager-cli-modules",
  setup(build) {
    build.onLoad({ filter: /\/(?:render|mosaic-preview|service|thread-capture|thread-draft|mcp)\.ts$/ }, ({ path }) => {
      throw new Error(`Command loaded an unrelated module: ${path.split("/").pop()}`);
    });
  },
});
