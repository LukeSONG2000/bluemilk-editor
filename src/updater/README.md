# Standalone update helper (integration in progress)

`BlueMilk.Updater.exe` is a self-contained Windows x64 executable, published into
the client's `updater` directory by `src/client/build.ps1`. Copy it outside the
installation before use; it must not replace itself. It accepts one absolute
path to a local JSON job. This is a trusted local deployment interface, not a
remote API or a signature/authenticity boundary.

Job fields (PascalCase): `SchemaVersion: 1`, `Channel: "exe" | "msix"`, four-part
`Version` ending in `.0`, `PackagePath`, `Size`, `Sha256`, `InstallDirectory`,
`ServerDirectory`, `ParentPid`, `ParentStartedUtcTicks` (.NET UTC ticks).
All paths must be absolute. The desktop must provide the downloaded GitHub
release's expected digest and size, its real installation directory and its own
process identity. Do not synthesize jobs from untrusted URLs or Mod input.

The helper holds the package open against writes/deletion, verifies its hash and
size, checks signed MSIX metadata where applicable, waits for the original client,
then calls guarded runtime shutdown and acquires the update lease. It also waits
for named client/runtime/CLI processes using that installation, including the
PyInstaller bootstrapper. It does not kill processes or retry a shutdown request.

EXE deployment uses the existing Inno installer with no Windows restart. MSIX
deployment uses system Windows PowerShell `Add-AppxPackage`, allowing Windows to
enforce signature and certificate trust. No certificate is added by the helper.
Installed file/package version must match before restarting the correct entry
point. Installer execution has no automatic timeout: releasing the lease while
the installer is still writing would be unsafe.

`receipt.json` is atomically replaced after a flushed write at each stage.
`installed` distinguishes successful deployment followed by restart failure from
an unconfirmed installation. `installed-restart-requested` does **not** prove the
new window rendered or stayed alive. The same job is never replayed once a receipt
exists, including failed or interrupted attempts. Keep unknown receipts for
diagnosis; do not delete one to retry. Exit codes: 0 restart requested, 1 failed,
2 invalid invocation, 3 existing receipt, 4 job already owned/inaccessible.

Verification:

```powershell
dotnet publish src/updater/BlueMilk.Updater.csproj -c Release -o logs/updater-helper
py tests/verify_updater_rejection.py logs/updater-helper/BlueMilk.Updater.exe
```

Current evidence includes real same-version EXE and MSIX 0.1.10 deployment and
restart on the development machine, plus invalid-job and replay rejection. This
does not establish cross-version upgrade, download-to-install UI integration,
failure rollback, or arbitrary third-party process compatibility. The WinUI
install button/job handoff remains to be implemented. Current runtimes hold both
endpoint-local and user-wide shared update handles; the updater acquires both
exclusively. This prevents a cooperating alternate-endpoint host from starting
after process scanning. Old binaries that lack the version-2 user-wide gate must
be closed; this protocol cannot prevent arbitrary noncooperating executables from
being launched. A connected version-1 server is explicitly rejected.
