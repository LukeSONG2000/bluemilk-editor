#ifndef PublishDir
  #error PublishDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{703A2E24-7644-42A6-83C5-06B7F84D01D1}
AppName=BlueMilk Editor
AppVersion={#AppVersion}
AppPublisher=BlueMilk project
DefaultDirName={autopf}\BlueMilk Editor
DefaultGroupName=BlueMilk Editor
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
UsePreviousPrivileges=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputDir}
OutputBaseFilename=BlueMilk-Editor-{#AppVersion}-Setup
SetupIconFile={#PublishDir}\Assets\account-portrait.ico
UninstallDisplayIcon={app}\BlueMilk.Editor.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=no
RestartApplications=no
SetupLogging=yes
ChangesAssociations=yes
UninstallDisplayName=BlueMilk Editor

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\BlueMilk Editor"; Filename: "{app}\BlueMilk.Editor.exe"; WorkingDir: "{app}"

[Registry]
Root: HKA; Subkey: "Software\Classes\.bluemilk"; ValueType: string; ValueName: ""; ValueData: "BlueMilk.ModPackage"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.bluemilk\OpenWithProgids"; ValueType: string; ValueName: "BlueMilk.ModPackage"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage"; ValueType: string; ValueName: ""; ValueData: "BlueMilk Mod 包"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\Assets\mod-package.ico"",0"
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\BlueMilk.Editor.exe"" --install-mod ""%1"""

[Run]
Filename: "{app}\BlueMilk.Editor.exe"; Description: "Launch BlueMilk Editor"; Flags: nowait postinstall skipifsilent

; No UninstallDelete rules: user Mod packages, configuration and unknown
; transaction receipts are never owned by the application installer.
