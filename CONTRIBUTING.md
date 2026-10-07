# Contributing

## Development

```sh
pnpm install
pnpm typecheck       # the sources and the specs
pnpm lint            # ESLint and Prettier; `pnpm format` fixes what it can
pnpm test            # node:test, straight from TypeScript
pnpm test:coverage   # the same, failing below 100% of lines, branches and functions
pnpm build           # dist/: the JavaScript and its type declarations
```

- The specs sit next to the sources (`src/*.spec.ts`) and run straight from TypeScript, through Node's type stripping. So a file a spec imports cannot use enums, decorator syntax or parameter properties, and the specs apply `@Transactional()` by hand. The fakes they share live in `src/testing`, which is not published.
- `src/postgres.spec.ts` runs the package against a real Postgres when `DB_HOST` is set, with `DB_PORT` (5432 when unset), `DB_USERNAME` and `DB_PASSWORD` as the server needs; without `DB_HOST` it is skipped, as in CI. It creates a database named `dakaio_transactional_test` for itself and drops it when done, so the user needs the right to create databases.
- No magic values: a text is compared through a named constant (an `as const` object and its type), and every number is a named, documented constant. `pnpm lint` enforces both.
- CI runs the type check, the linter, `pnpm test:coverage` and the build on every push to `main`.

## Releasing

Raise `version` in `package.json` in a pull request. After it is merged, run `pnpm release` on a clean checkout: it tags `main` with `v<version>` and pushes the tag, and the `publish` workflow tests, builds and publishes to npm.

Publishing uses npm trusted publishing: no token is stored anywhere. The first version is published by hand from a clean checkout (`pnpm install`, `npm login`, then `npm publish --provenance=false`: provenance can only be made inside GitHub Actions); after that the package's npm settings name this repository's `publish.yml` as its Trusted Publisher.
