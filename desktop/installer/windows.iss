#define AppName "Date Stamp Cleaner"
#define AppVersion GetEnv("DATE_STAMP_APP_VERSION")
#define AppPublisher "Date Stamp Cleaner"
#define AppExeName "Date Stamp Cleaner.exe"

[Setup]
AppId={{E67393DB-0137-4D69-B957-B9524A6B725D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=DateStampCleaner-Windows-x64-Setup
SetupIconFile=..\assets\app-icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "..\dist\Date Stamp Cleaner\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent
