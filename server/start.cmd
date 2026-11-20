@echo off
rem PrivChat 公网中继启动壳（计划任务 \PrivChat-Hub 调用本文件）
rem 工作目录固定 C:\PrivChat-Hub，日志追加到 logs\hub.log
cd /d C:\PrivChat-Hub
if not exist logs mkdir logs
if not exist data mkdir data
"C:\PrivChat-Hub\node\node.exe" "C:\PrivChat-Hub\server.mjs" >> "C:\PrivChat-Hub\logs\hub.log" 2>&1