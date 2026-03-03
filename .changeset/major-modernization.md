---
"transloadit-notify-url-proxy": major
---

Modernize the package with breaking runtime and tooling changes:

- switch to ESM and TypeScript source in `src/`
- require Node.js 24+ with native TypeScript execution
- add CLI bin entrypoint (`notify-url-proxy`)
- replace deprecated dependencies (`request`, `underscore`) with native APIs
- migrate project tooling to Yarn 4, Biome, Vitest, GitHub Actions, and Changesets
