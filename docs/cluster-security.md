# Cluster and Security

Cluster shows this computer and explicitly paired inference nodes. CPU, RAM, GPU,
storage, and network readings come from the node; unavailable readings remain blank.
Antimatter does not estimate missing metrics or accept arbitrary remote commands.

When creating a pairing offer in Settings → Models → Nodes, choose which access
it grants. Inventory is the default. Detailed vitals and engine management are
separate opt-in permissions. Existing pairings retain their original permissions;
re-pair on the node to add access. Revoke old controllers on that node when replacing
a pairing. Certificate pinning and the stored controller credential protect each
request.

Start, stop, and restart apply only to registered engines managed by Antimatter.
Externally managed engines stay read-only. Stop and restart require confirmation;
interrupting an engine serving active work is called out in that confirmation.
Repeated request identifiers are deduplicated, and the dashboard shows a bounded
session action log. If a remote action fails, refresh before retrying: a lost response
does not prove that the engine remained unchanged.

Security scans the active chat's confirmed workspace using the same pattern engines
as `scan_code` and `scan_secrets`. It runs locally without executing project scripts.
Hidden source/configuration files are included. Generated directories, symlinks,
binary files, unreadable or changing files, and files over 512 KiB are skipped.
Lines over 2,000 characters are skipped by the shared pattern engine. Each scan is
limited to 20,000 files, 100,000 directory entries, 64 MiB of text, 2,000 findings,
and one minute. Cancellation or a limit produces a visibly incomplete report.

Reports contain relative file locations and rule descriptions, without matched
credential text. Review findings as Open, Dismissed, or Resolved and add notes.
Dismissals carry forward only for unchanged files. Resolved findings reopen if
another scan still finds the pattern. Reports are stored privately on this computer;
the last ten reports are retained per project. Removing a report does not alter
project files. Export JSON, Markdown, or SARIF 2.1.0 through the save dialog.

Pattern findings need human review and can include false positives. Scan coverage
states what was skipped; a report with no matches is not proof of security.
