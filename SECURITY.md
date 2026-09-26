# Security

This repository is intentionally public and must contain only generic technical code.

Prohibited in git history:

- Google service-account private keys;
- OAuth refresh/access tokens;
- GitHub personal access tokens;
- Ligorverso canonical text or private source exports;
- SQLite snapshots containing project content;
- private manifests or state dumps.

Runtime credentials, if later authorized, must use GitHub Actions Secrets and least privilege.
