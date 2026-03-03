# transloadit-notify-url-proxy

Local `notify_url` proxy for Transloadit assemblies.

This version is modernized for:

- Node.js 24+
- Native TypeScript execution (type stripping)
- ESM
- Yarn 4
- Biome + Vitest + GitHub Actions + Changesets

## Install

```bash
yarn add transloadit-notify-url-proxy
```

## CLI usage

```bash
notify-url-proxy \
  --secret "$TRANSLOADIT_SECRET" \
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

## Releases

Changesets drives releases:

```bash
yarn changeset
yarn changeset:version
```

On pushes to `main`, `.github/workflows/release.yml` runs `changesets/action` to publish.
