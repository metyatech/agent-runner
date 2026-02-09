Option Explicit

Dim fso, scriptDir, repoDir, ps1Path, tokenEnv, cmd, shell

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)
ps1Path = scriptDir & "\run-cloudflared.ps1"

tokenEnv = "CLOUDFLARED_TUNNEL_TOKEN"
If WScript.Arguments.Count >= 1 Then
  tokenEnv = WScript.Arguments.Item(0)
End If

cmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1Path & _
  """ -RepoPath """ & repoDir & """ -TokenEnv """ & tokenEnv & """"

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = repoDir
shell.Run cmd, 0, True
