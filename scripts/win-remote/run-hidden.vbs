' launches the queue bridge with NO window (style 0). Windows Terminal
' (the Win11 default console host) ignores -WindowStyle Hidden — this is
' the reliable way to keep the bridge off the automated desktop.
CreateObject("Wscript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\gold\win-remote\queue-agent.ps1", 0, False
