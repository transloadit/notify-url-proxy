# transloadit-notify-url-proxy

Local `notify_url` proxy for Transloadit assemblies.

This version is modernized for:

- Node.js 24+
- Native TypeScript execution (type stripping)
- ESM
- Yarn 4
- Biome + Vitest + GitHub Actions + Changesets

Notify payloads are signed via `@transloadit/utils` using prefixed `sha384` signatures.

## Install

```bash
yarn add transloadit-notify-url-proxy
```

## CLI usage

```bash
export TRANSLOADIT_SECRET="your-secret"

notify-url-proxy \
  --notifyUrl "http://127.0.0.1:3000/transloadit" \
  --port 8888
```

Run `notify-url-proxy --help` for all options.

## Programmatic usage

```ts
import TransloaditNotifyUrlProxy from 'transloadit-notify-url-proxy';

const proxy = new TransloaditNotifyUrlProxy(
  process.env.TRANSLOADIT_SECRET ?? '',
  'http://127.0.0.1:3000/transloadit'
);

proxy.run({
  port: 8888,
  target: 'https://api2.transloadit.com/assemblies/',
  pollIntervalMs: 2000,
  maxPollAttempts: 10
});
```

## Development

```bash
corepack enable
yarn install

yarn lint
yarn typecheck
yarn test
yarn check
```

## Real API E2E

Run an opt-in test against the real Transloadit API:

```bash
yarn env:sync:node-sdk
yarn test:real
```

This copies `TRANSLOADIT_KEY` and `TRANSLOADIT_SECRET` from `~/code/node-sdk/.env` into a local
`.env` (gitignored), then runs `test/real.e2e.test.ts`.

## Releases

Changesets drives releases:

```bash
yarn changeset
yarn changeset:version
```

On pushes to `main`, `.github/workflows/release.yml` runs `changesets/action` to publish.
