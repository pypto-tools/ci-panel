# Process runner regressions — issue #59

A missing listener does not imply an exited process group: `run-helper.sh` waits five seconds before retrying.
Stop/detach must wait for group exit, preserve its PGID meanwhile, and block manual or automatic respawn.
Zombie-only groups and prior-boot identities count as stopped.
Signals require a matching leader boot ID, start ticks and directory, or fresh listener ownership after identity inspection.
Before every signal, group inspection rejects prior-boot or absent records even when the directory and PGID match a live listener.
A saved identity with unknown group state keeps stopping pending until inspection succeeds; legacy records retain fresh-listener fallback.
Process-group existence alone grants no authority to signal it.

- `daemon/test/pure-logic/process_group_lifecycle.spec.ts` covers group lifetime, retry windows, and replacement during identity inspection at every stop stage.
- `daemon/test/pure-logic/process_retry_window.spec.ts` uses a real wrapper and five-second retry without GitHub access; it retains every spawned child for cleanup even if duplicate spawning breaks an assertion.
- `daemon/test/security/process_group_probe.spec.ts` covers PID reuse evidence, probe errors, old runtime records, and boot-aware signal authorization.

Run the daemon suite, type-check and build using the commands in [the testing guide](../TESTING.md#11-how-to-verify-the-setup-itself).
