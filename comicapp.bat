@echo off
echo ========================================
echo Starting Comic Server...
echo Keep this window open for server logs.
echo LM Studio AI will boot on-demand when translating.
echo ========================================

:: Run Node directly so logs are shown. It will open Chrome dynamically.
node "%~dp0comic-viewer\server.js"

pause