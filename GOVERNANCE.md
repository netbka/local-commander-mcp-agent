# Governance

## Maintainer

Local Commander's open-source edition has one maintainer: Peter Mamrukov ([@netbka](https://github.com/netbka)). The maintainer reviews and merges every change and publishes every release: the npm package, the GHCR image, GitHub releases and the MCP registry entry. Publishing accounts use two-factor authentication.

## How decisions are made

- Bugs and ideas go to [GitHub issues](https://github.com/netbka/local-commander-mcp-agent/issues). Larger changes are discussed in an issue before code is written.
- The maintainer decides what is merged and when it is released, and explains a refusal in the issue or pull request.
- Changes that affect security (roots, blocked files, the command allowlist, authentication) also need a test that shows the protection still holds.

## Contributions

Pull requests are welcome under the MIT license. Each change needs passing `npm run typecheck`, `npm test` and `npm run build`.

This repository is exported from the maintainer's development repository. An accepted pull request is applied there and arrives here with the next export, with credit to the author.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Continuity

The code is MIT-licensed, so anyone can fork it. If the maintainer stops maintaining the project, the README will say so and point to an active fork if there is one.
