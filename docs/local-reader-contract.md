# Reusable local Reader

The local Reader is a read-only software component implementing `unified_context_v1`.

It is deliberately independent from:
- snapshot version;
- snapshot hash;
- logical database ID;
- Drive file ID;
- publication generation.

Compatibility is capability-based. A SQLite file is accepted when it exposes the structural objects and FTS behavior required by the Reader contract and passes integrity validation.

Example:

`node scripts/read-context-local.mjs --db /path/to/bank.db --query "Caio pode voar carregando Eduarda?"`

The Reader does not download or select a database. Transport/loaders are separate concerns. This allows the same Reader build to be reused with any compatible structured bank.
