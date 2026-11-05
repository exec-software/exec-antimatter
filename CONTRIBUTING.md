# Contributing to Antimatter

Use the supported Node.js version listed in `package.json`. Run `npm ci`,
`npm run typecheck`, and `npm test`; see [development setup](docs/development.md)
for optional UI and platform checks. Do not use a model download or a live GPU
run as an implicit part of an ordinary test.

## Pull requests

Keep changes focused, explain the intended behavior, and add a regression test
for fixes. Update the public documentation when setup or observable behavior
changes. Report the exact checks run and any skipped or blocked checks; do not
claim hardware or model qualification from compilation alone.

Do not include private configuration, credentials, machine paths, internal
research, chat exports, memory databases or raw diagnostic bundles. Review the
[publication checklist](docs/publication.md), including history and packaged
assets. Report vulnerabilities through [SECURITY.md](SECURITY.md).

First-party contributions use the repository's [MIT license](LICENSE).
Preserve third-party notices and identify the source and redistribution terms of
new dependencies, datasets and other assets. Model weights and user data are not
automatically covered by the source-code license.

Release identity, signing, publication, and repository visibility are maintainer
operations. A source cleanup or passing local test does not publish a release.
