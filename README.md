# OpenCode Edit Diagnostics Pruner

Keep diagnostics for the files edited by each `apply_patch`, `edit`, or `write` call. Preserve tool output, titles, edited-file diagnostics, and all other metadata, including provider metadata. Unknown diagnostic keys remain intact.

## Install first

Place this directory at a permanent location. Add its `plugin.mjs` file as the **first** entry of the existing OpenCode `plugin` list, preserving the other entries:

```json
{
  "plugin": [
    "file:///opt/plugins/opencode-edit-diagnostics-pruner/plugin.mjs"
  ]
}
```

Replace the example location with your actual installation path, then restart OpenCode. No dependencies or build step are needed for the plugin; it is portable Node ESM. Node 22.22.1 was used for compatibility checks. Historical cleanup additionally requires Bun (tested with 1.3.11) and Python 3 with standard-library SQLite.

The `tool.execute.after` interface and apply_patch metadata shape were checked against OpenCode 1.18.34. This hook changes final results only. Running `ctx.metadata` updates and existing history remain untouched. Other plugins that run later may add diagnostics again. This project makes no CPU or RSS reduction guarantee.

## Preview one historical session

Stop the OpenCode host before applying historical cleanup. A stopped session can still contain unfinished tool parts; pending/running current parts must be resolved before apply. The flag below is an operator assertion, not a command that stops OpenCode.

These examples use synthetic names. Supply your own explicit database path and session identifier after inspecting a preview:

```sh
bun /opt/plugins/opencode-edit-diagnostics-pruner/history.mjs \
  --db /var/tmp/synthetic-opencode.sqlite --session ses_synthetic_example
```

Default mode opens the database read-only and produces a JSON report. It does not discover any default database or session. Missing databases are refused rather than created.

## Apply with a full backup

```sh
bun /opt/plugins/opencode-edit-diagnostics-pruner/history.mjs \
  --db /var/tmp/synthetic-opencode.sqlite --session ses_synthetic_example \
  --apply --session-stopped --backup /var/tmp/synthetic-opencode-before.sqlite
```

The backup parent directory must exist. The backup must be outside this plugin repository; existing destinations are refused. Omitting `--backup` generates a unique backup beside the source database, also subject to the outside-repository rule. The path is included in the report on success.

Apply performs a full SQLite online backup, including committed WAL contents, validates it with `quick_check`, and sets permissions to `0600`. Allow enough disk space and time for the entire database, not just the selected session. Updates run in one transaction. Any commit detected on the source connection between preflight and acquisition of the write lock aborts cleanup; the completed backup remains available. Stop the host and retry with a new destination. Row conflicts and update errors roll back all cleanup writes.

This protection assumes a quiescent source file and normal SQLite writers. It does not protect against replacing the database file, bypassing SQLite locking, or changes after the CLI exits. Keep OpenCode stopped throughout backup and cleanup. Avoid placing backups in a shared or publicly readable directory, even though the file itself has restrictive permissions.

Reports count changed `partRows`, changed `eventRows`, removed diagnostic file entries across both types of stored copy, `skippedRows`, `activeParts`, and `removedBytes`. Bytes measure the net UTF-8 JSON change, not physical database space. JSON may be reserialized. No automatic VACUUM is performed.

For rollback, keep the host stopped and restore the complete backup through SQLite's backup API into the intended database. Do not copy a lone database file over a live WAL database or mix old WAL/SHM files with a restored database. This tool intentionally provides cleanup only; it does not automate restoration of a real host database.

## Boundaries

Only `state.metadata.diagnostics` is filtered in historical tool parts and completed `message.part.updated.1` event snapshots of the exact session. Event IDs, sequence numbers, types, envelope fields, tool input/output, and provider metadata are preserved. Historical running event snapshots remain intact; completed copies are processed individually so replaying them uses the filtered final results.

`apply_patch` requires an unambiguous nonempty `metadata.files` list with absolute paths; moves preserve source and destination diagnostics. `edit` and `write` use `args.filePath` live, or `state.input.filePath` historically, resolving relative paths against the host project directory or stored `session.directory`. No patch-text inference is used. Unresolved edited paths preserve the entire diagnostics map. Nonabsolute or unrecognized diagnostic keys remain intact. Windows drive and UNC paths are supported lexically; path matching does not follow symlinks or guess case equivalence.

The supported database columns and skip behavior are specified in [the contract](.sisyphus/docs/contract.md). Missing tables/columns fail closed. Malformed JSON, conflicting embedded identities, unknown terminal statuses, and unknown part shapes are preserved; they may require separate investigation before replay consistency can be claimed for those rows. A preview's `skippedRows` reports malformed/unsupported row shapes, not every unchanged tool or unresolved path.

## Synthetic verification

```sh
bun test test/
npm run check
```

Tests create only temporary synthetic databases. They cover metadata preservation, path handling, hook behavior, preview, full WAL-aware backup and restoration, event replay copies, running-part rejection, schema refusal, concurrent commits, row conflicts, and atomic rollback. They never discover or open an existing OpenCode session database. Live host integration remains an operator validation step.
