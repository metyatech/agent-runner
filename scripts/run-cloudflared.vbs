Option Explicit

Dim fso, scriptDir, repoDir, ps1Path, cmd, shell

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
ps1Path = scriptDir & "\run-cloudflared.ps1"

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1Path & _
  """ -RepoPath """ & repoDir & """ -TokenEnv ""CLOUDFLARED_TUNNEL_TOKEN"""

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repoDir
shell.Run cmd, 0, True

