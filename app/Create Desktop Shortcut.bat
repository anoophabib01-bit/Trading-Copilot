@echo off
rem Creates a "Co-Pilot" shortcut on the Desktop pointing at launch.bat.
rem Run this ONCE (double-click). After that, start the app from the Desktop icon.
set SCRIPT="%TEMP%\copilot-shortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") > %SCRIPT%
echo sLinkFile = oWS.SpecialFolders("Desktop") ^& "\Co-Pilot.lnk" >> %SCRIPT%
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> %SCRIPT%
echo oLink.TargetPath = "%~dp0launch.bat" >> %SCRIPT%
echo oLink.WorkingDirectory = "%~dp0" >> %SCRIPT%
echo oLink.Description = "MNQ Trading Co-Pilot" >> %SCRIPT%
echo oLink.Save >> %SCRIPT%
cscript //nologo %SCRIPT%
del %SCRIPT%
echo.
echo  Done - "Co-Pilot" shortcut created on your Desktop.
pause
