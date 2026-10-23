# Security policy

Local Commander gives an AI assistant files, Git, commands and localhost services on your computer, so security reports get priority over feature work.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest 0.1.x release (npm `local-commander-mcp-agent`, GHCR image, GitHub release) | Yes |
| Older releases | No. Upgrade first, then check whether the problem remains. |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Email Peter Mamrukov at [peter.mamrukov@localcmd.app](mailto:peter.mamrukov@localcmd.app) with:

- a short description of the problem and its impact;
- the version and how you run it (npx, Docker, Node.js; stdio or HTTP; auth mode);
- whether you want to be credited.

Do not put passwords, tokens, private keys or a working exploit in the first message. You will get a reply with a secure way to share the details.

## What to expect

- An acknowledgement within 5 business days.
- An assessment, and a fix or mitigation plan, once the problem is confirmed.
- A patched release, published with release notes that describe the issue after users can upgrade. Reporters are credited if they want.

## Scope

In scope: this repository, the `local-commander-mcp-agent` npm package and the `ghcr.io/netbka/local-commander-mcp-agent` image. Examples: escaping the configured roots, reading blocked secret files, running a command that is not allowlisted, bypassing OAuth or bearer authentication on the HTTP transport, and requests to hosts other than localhost.

Known limits, not vulnerabilities: outside Docker, child processes are not OS-sandboxed, so an allowlisted interpreter can read anything the account can read (see "Security model" in the README).

The hosted multi-computer service at [localcmd.app](https://localcmd.app) uses the same contact; see [security.txt](https://localcmd.app/.well-known/security.txt).
