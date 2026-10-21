@echo off
cd /d "%~dp0"
echo Starting ExamSync. Keep this window open while using the site.
call npm start
echo.
echo ExamSync has stopped.
pause