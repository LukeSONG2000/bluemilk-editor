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
AppName=BlueMilk Editor (EXE)
AppVersion={#AppVersion}
AppPublisher=BlueMilk project
DefaultDirName={localappdata}\Programs\BlueMilk Editor
DefaultGroupName=BlueMilk Editor
PrivilegesRequired=lowest
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
UninstallDisplayName=BlueMilk Editor (EXE)

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\BlueMilk Editor (EXE)"; Filename: "{app}\BlueMilk.Editor.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\BlueMilk.Editor.exe"; Description: "Launch BlueMilk Editor"; Flags: nowait postinstall skipifsilent

; No UninstallDelete rules: user Mod packages, configuration and unknown
; transaction receipts are never owned by the application installer.
