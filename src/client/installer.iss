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
AppPublisher=LukeSONG2000
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
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=no
ShowLanguageDialog=auto
SetupLogging=yes
ChangesAssociations=yes
UninstallDisplayName=BlueMilk Editor

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zhCN"; MessagesFile: "Languages\ChineseSimplified.isl"
Name: "zhTW"; MessagesFile: "Languages\ChineseTraditional.isl"

[CustomMessages]
en.LaunchEditor=Launch BlueMilk Editor
zhCN.LaunchEditor=启动 BlueMilk Editor
zhTW.LaunchEditor=啟動 BlueMilk Editor
en.ModPackage=BlueMilk Mod package
zhCN.ModPackage=BlueMilk Mod 包
zhTW.ModPackage=BlueMilk Mod 套件
en.CloseEditor=BlueMilk Editor or its shared runtime is using this installation.%n%nClose them and continue? CLI connections to this runtime will be disconnected. The game will remain open.
zhCN.CloseEditor=检测到此安装目录的 BlueMilk Editor 或共享服务正在运行。%n%n是否关闭它们后继续安装？使用该服务的 CLI 连接将断开，游戏本体不会关闭。
zhTW.CloseEditor=偵測到此安裝目錄的 BlueMilk Editor 或共用服務正在執行。%n%n是否關閉它們後繼續安裝？使用此服務的 CLI 連線將中斷，遊戲本體不會關閉。
en.PrepareFailed=Unable to release the installation files. Exit BlueMilk Editor from its tray menu and close CLI connections, then retry. Nothing has been overwritten.
zhCN.PrepareFailed=无法释放安装文件。请从系统托盘退出 BlueMilk Editor 并关闭 CLI 连接后重试。尚未覆盖文件。
zhTW.PrepareFailed=無法釋放安裝檔案。請從系統匣結束 BlueMilk Editor 並關閉 CLI 連線後重試。尚未覆寫檔案。
en.CloseDeclined=Installation paused. Close BlueMilk Editor and retry, or cancel installation.
zhCN.CloseDeclined=安装已暂停。请退出 BlueMilk Editor 后重试，或取消安装。
zhTW.CloseDeclined=安裝已暫停。請結束 BlueMilk Editor 後重試，或取消安裝。

[Files]
Source: "{#PublishDir}\updater\BlueMilk.Updater.exe"; DestName: "BlueMilk-InstallPrepare.exe"; Flags: dontcopy
Source: "{#PublishDir}\*"; DestDir: "{app}"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\BlueMilk Editor"; Filename: "{app}\BlueMilk.Editor.exe"; WorkingDir: "{app}"

[Registry]
Root: HKA; Subkey: "Software\Classes\.bluemilk"; ValueType: string; ValueName: ""; ValueData: "BlueMilk.ModPackage"; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\.bluemilk\OpenWithProgids"; ValueType: string; ValueName: "BlueMilk.ModPackage"; ValueData: ""; Flags: uninsdeletevalue uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage"; ValueType: string; ValueName: ""; ValueData: "{cm:ModPackage}"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\Assets\mod-package.ico"",0"
Root: HKA; Subkey: "Software\Classes\BlueMilk.ModPackage\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\BlueMilk.Editor.exe"" --install-mod ""%1"""

[Run]
Filename: "{app}\BlueMilk.Editor.exe"; Description: "{cm:LaunchEditor}"; Flags: nowait postinstall skipifsilent

[Code]
var
  PrepareState: String;
  Prepared: Boolean;

function GetCurrentProcessId: LongWord;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

procedure ReleasePreparation;
var State: AnsiString; I: Integer;
begin
  if PrepareState = '' then exit;
  if LoadStringFromFile(PrepareState, State) and (State = 'ready') then begin
    SaveStringToFile(PrepareState, 'release', False);
    for I := 1 to 100 do begin
      if LoadStringFromFile(PrepareState, State) and (State = 'released') then break;
      Sleep(50);
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Helper, Arguments: String; Code, I: Integer; State: AnsiString;
begin
  Result := '';
  if Prepared then exit;
  ExtractTemporaryFile('BlueMilk-InstallPrepare.exe');
  Helper := ExpandConstant('{tmp}\BlueMilk-InstallPrepare.exe');
  if not Exec(Helper, '--query-install ' + AddQuotes(ExpandConstant('{app}')), '', SW_HIDE, ewWaitUntilTerminated, Code) then begin
    Result := CustomMessage('PrepareFailed'); exit;
  end;
  if Code = 2 then begin
    if WizardSilent then begin Result := CustomMessage('PrepareFailed'); exit; end;
    if MsgBox(CustomMessage('CloseEditor'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then begin
      Result := CustomMessage('CloseDeclined'); exit;
    end;
  end else if Code <> 0 then begin Result := CustomMessage('PrepareFailed'); exit; end;
  { The in-app updater already holds the installation lease. }
  if ExpandConstant('{param:BLUEMILKUPDATER|0}') = '1' then begin
    if Code <> 0 then Result := CustomMessage('PrepareFailed') else Prepared := True;
    exit;
  end;
  PrepareState := ExpandConstant('{tmp}\bluemilk-prepare-state.txt');
  DeleteFile(PrepareState);
  Arguments := '--prepare-install ' + AddQuotes(ExpandConstant('{app}')) + ' ' + IntToStr(GetCurrentProcessId) + ' ' + AddQuotes(PrepareState);
  if not Exec(Helper, Arguments, '', SW_HIDE, ewNoWait, Code) then begin Result := CustomMessage('PrepareFailed'); exit; end;
  for I := 1 to 450 do begin
    if LoadStringFromFile(PrepareState, State) then begin
      if State = 'ready' then begin Prepared := True; Log('BlueMilk installation preparation ready; files released and lease held'); exit; end;
      if Pos('failed:', State) = 1 then begin Log('BlueMilk preparation: ' + String(State)); break; end;
    end;
    Sleep(100);
  end;
  Result := CustomMessage('PrepareFailed');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then ReleasePreparation;
end;

procedure DeinitializeSetup;
begin
  ReleasePreparation;
end;

// No UninstallDelete rules: user Mod packages, configuration and unknown
// transaction receipts are never owned by the application installer.
