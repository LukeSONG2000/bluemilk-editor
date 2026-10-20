# SDK v1 — currently implemented interface

Mod entry points export a synchronous CommonJS factory:

```javascript
module.exports = sdk => sdk.battle.information.install();
```

The factory receives an immutable API object with `version: 1` and
`mod: {id, version}`. No `require`/ES module resolver is provided.
Package inspection and registration do not execute this factory.

## Information UI

`sdk.battle.information.install()` requires the manifest capability
`battle.information.ui`. It delegates to the original project implementation
of the game's health/protection numbers, cooldowns and limited-duration statuses.
It does not implement replacement combat rules.

Call it once, synchronously inside the factory, and return its lifecycle handle.
The handle has `ready`, `status()` and `stop()`; the loader awaits readiness
and requires confirmed `enabled`/`stopped` states. The UI provider has one owner.
Attempting to acquire it twice, or from another simultaneously enabled Mod, fails.
If the factory throws after acquisition, the loader retains the handle so an
explicit disable can verify restoration. Failure to restore is not reported as success.

The runtime bundles `mods/information` using the public package authoring tool.
On explicit game connection it installs this immutable package into the common
package store, registers its verified entry, and enables it only when the
connection's information option requests it. Automatic installation is currently
limited to this bundled project Mod. Same-ID/version content conflicts fail closed.
The older `official_information_mod.js` is retained as historical source but is
not loaded by the current normal runtime.

## Boundaries and remaining work

These are supported API checks, **not security permissions or a sandbox**.
Trusted in-process JavaScript can access the process directly. SHA-256 identifies
content and does not authenticate a publisher.

General battle events, data querying, command registration, configuration and
generic hook/UI ownership APIs are not yet provided. The information package's
`battle.information.read` declaration describes intended scope; it does not yet
expose a public data-query method. Existing private protocol snapshots remain
available separately. This first interface is not the complete planned SDK.

Actual game-process acceptance so far covers two package enable/disable cycles
at the Home screen. The WinUI Mod page now exposes inspection, installation, loading
and enable/disable through the shared protocol; independent CLI readback confirms
the same enabled/disabled state. Visual acceptance is still pending because both
the prior client and this build produced blank client areas on the current desktop.
Battle-mode UI, restart selection, upgrade/uninstall and cross-mode/performance
acceptance remain outstanding.
