# SDK 2

Editor supplies connection, original-game adapters, package verification and
resource lifetime. Mods supply feature code, formatting, native UI policy,
desktop declarations and command handlers. Pro's implementation is maintained in
the separate `bluemilk-pro` repository, not bundled with Editor.

## Package modules

Set `sdkVersion: 2`. The entry exports a synchronous factory accepting `sdk`.
Package-local `require('./module')` resolves `.js` and `.json` from the verified
file inventory, with module caching and bounded relative traversal. Node modules,
filesystem imports and imports outside the package are unavailable.
Inspection and registration never evaluate module bodies; enabling evaluates
them. Integrity checks do not authenticate the publisher or sandbox trusted code.

## Generic resources and adapters

`sdk.lifecycle.own(handle)` adopts a resource during the factory. A handle has
`ready`, `status()` with `lifecycle`, and `stop()` confirming `stopped`.
`sdk.lifecycle.compose({command})` returns a composite lifecycle, cleaning resources
in reverse order and retaining failed cleanup for an explicit retry. A factory
throwing after adoption leaves owned handles available for cleanup.

`native.ui` grants supported access to `sdk.native.runtime` and
`sdk.native.scene`, the existing IL2CPP/main-thread/Unity adapters. It does not
install a feature. The package owns hooks, labels, restoration and timers.
`sdk.native.on(topic, callback)` subscribes during the factory and automatically
unsubscribes during cleanup. `ui.popup.updated` carries native `popup` and `unit`
handles after an explicitly requested original status popup opens.

`sdk.native.readStatus(unit)` and `sdk.battle.snapshot({detailScope:'selected'})`
read original battle data; the latter is callable within Mod commands and returns
a copied JSON value. `sdk.game.unitName(id)` reads the supplied original name map
and falls back to the ID. Labels, grouping, numeric formatting and interpretation
for a product page belong to the Mod.

Native APIs are for trusted in-process code. Capability checks describe supported
use, not a security boundary. In particular, a read-query contract is not a sandbox.

## Desktop declarations

The manifest may declare:

```json
"desktop": {
  "version": 1,
  "query": "view",
  "refreshMs": 1000,
  "features": [
    {"id":"enabled","title":"Feature","kind":"toggle",
     "binding":"enabled","command":"set-enabled","home":true},
    {"id":"details","title":"Details","kind":"table","binding":"details",
     "columns":[{"key":"name","title":"Name"},{"key":"value","title":"Value"}],"home":true}
  ]
}
```

The generic renderer supports toggle, select, button, text and table. A table view model
contains optional `title`, `summary` strings, and `rows` objects keyed by columns.
Each view-model property is selected by its feature's top-level `binding`.
Toggle commands receive `{value:boolean}`. Button commands receive `{}`.
Queries receive `{features:[featureIds]}` so hidden tables need not read game data.
The homepage creates the same feature cards and tables as the Mod page, backed by
one query model. Only visible homepage features, the current Mod page and open
floating views request data. An optional `description` forms the second header line.

`select` declares at most 16 unique `options:[{value,label}]`; its command receives
`{value:string}`. A table cell can be a string or `{runs:[{text,tone}]}` (at most
8 runs). `tone` accepts `positive`/`negative`; other text uses the normal color.

A table can opt into a native always-on-top window with `floating`:
`{background:"#ED192940",foreground:"#FFFFFFFF",border:"#FF52CCF6",
fontFamily:"Arial",fontSize:16}`. Colors are ARGB; size is 12–24. Closing or
disabling the Mod closes its window. No overlay is opened automatically.

An optional `floating.fontAsset` requests an exact SFNT family from the installed
game's `resources.assets`. `mods-font` accepts `{id,sha256,family}` only for a
verified installed package declaring that family. The host derives the resource
path from the detected game, scans bounded SFNT tables and names, and returns a
hash-checked user-cache record. The desktop temporarily registers that local font
for the current Windows user and removes its own registration on normal exit.
Game font bytes are never bundled or downloaded. This is a local resource adapter,
not an arbitrary file read endpoint or a font distribution permission.

The schema is bounded: 32 features, 8 columns, query interval 1–60 seconds. It
contains data, not XAML/HTML or executable binding expressions. Packages own titles,
column definitions and view models. Host settings own homepage visibility.

## Shared client / CLI operations

`mods-query` has `{id,command,payload}` and accepts only the query declared by an
enabled Mod. Responses use the bounded read cache, preserving the durable mutation
ledger for writes. Queries must be side-effect-free and cannot request host game
operation handoffs. `mods-command` remains the explicit mutation channel.

`mods-set-enabled` has `{id,sha256,enabled}`. It saves a persistent preference,
works offline, and applies it to a connected session. Selecting a new version
first requires confirmed old-version cleanup, then loads the new verified package.
Failed cleanup retains the old registration. Failed new activation is reported
separately from saved intent; it is not silently replayed.

## Migration

The old `sdk.battle.information.install()` provider was removed. Packages declaring
the legacy `battle.information.ui` capability with SDK 1 are rejected before entry
execution, with an update instruction. Pro 0.2.0 requires Editor 0.2.0 or later.
Generic SDK 1 lifecycle packages remain supported. Historical Ultra adapters have
not been migrated by this change; no Ultra package is bundled or enabled.

### Original nine-slice image (Editor 0.2.2)

Optional `floating.spriteAsset` names an exact NGUI atlas sprite. `mods-image` accepts `{id,sha256,name}` only for a verified installed package declaring that name. The native adapter reads at most a 512×512 sprite, preserves RGBA and original borders, restores the previous render target and destroys temporary GPU textures. The host validates pixel geometry, writes a local PNG and caches its metadata under the supported game binary identity. Nothing is downloaded or redistributed. The native WinUI `Image.NineGrid` draws that local image over a transparent DWM surface; XAML foreground stays opaque. If no cached sprite or loaded original atlas exists, entering battle once is required.
