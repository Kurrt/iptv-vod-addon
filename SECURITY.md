# Security policy

Please report security problems privately, not in a public issue.

Use GitHub's private vulnerability reporting: open this repository's security tab and choose **Report a vulnerability**, or go straight to <https://github.com/Kurrt/iptv-vod-addon/security/advisories/new>.

Please leave out real credentials, hostnames and stream URLs. A made-up example is enough.

Only the latest version on `main` is supported.

One thing is by design and not a bug: stream responses contain the source's credentials. That is why the add-on must never have a public route. See the [security model](README.md#security-model).
