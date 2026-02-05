Option Explicit

Dim fso, scriptDir, repoDir, ps1Path, configPath, cmd, shell

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
ps1Path = scriptDir & "\run-task.ps1"
configPath = repoDir & "\agent-runner.config.json"

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1Path & _
  """ -RepoPath """ & repoDir & """ -ConfigPath """ & configPath & """"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repoDir
shell.Run cmd, 0, True

