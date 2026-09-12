' Launch Slate without a visible console window (double-click / Start Menu).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = scriptDir & "\start-windows-neverfear.cmd"
Set shell = CreateObject("WScript.Shell")
shell.Run """" & cmdPath & """", 0, False
