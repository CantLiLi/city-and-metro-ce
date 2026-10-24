; 城市与地铁社区版 Inno Setup 模板。
; @@XXX@@ 是 src/python/build/build.py 打包时替换的占位符，别在模板里写死路径，
; 否则模板就没法进版本库、也没法在别的机器上复用。

#define MyAppName "@@APP_NAME@@"
#define MyAppVersion "@@APP_VERSION@@"
#define MyAppExeName "@@APP_EXE@@"

[Setup]
AppId={{@@APP_ID@@}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher=@@APP_PUBLISHER@@
AppCopyright=Copyright (c) @@APP_PUBLISHER@@
VersionInfoVersion={#MyAppVersion}
; 每人自己装到 %LOCALAPPDATA%，不弹 UAC；存档也写在用户目录下，不需要管理员权限
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\@@INSTALL_DIR@@
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir=@@OUTPUT_DIR@@
OutputBaseFilename=@@OUTPUT_BASE@@
SetupIconFile=@@ICON_FILE@@
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "@@DIST_DIR@@\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
