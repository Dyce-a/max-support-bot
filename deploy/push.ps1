# ============================================================
#  bot_support — деплой на сервер (запускать в PowerShell на Windows)
#
#  Что делает:
#   1) пакует проект в .tar.gz (без node_modules и мусора)
#   2) копирует архив на сервер по SSH
#   3) распаковывает и запускает deploy/setup-server.sh на сервере
#
#  Перед первым запуском заполни 3 переменные ниже.
#  Потом просто:  powershell -ExecutionPolicy Bypass -File .\deploy\push.ps1
# ============================================================

# >>>>>>>>>>>>>>>>>>>>  ЗАПОЛНИ ЭТО  <<<<<<<<<<<<<<<<<<<<
$Server  = "user@192.168.0.10"      # SSH: пользователь@хост (или alias из ~/.ssh/config)
$SshPort = 22                         # порт SSH
$SshKey  = ""                         # путь к приватному ключу, если нужен (иначе оставь пустым)
# >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot   # папка проекта (на уровень выше deploy/)
$Tar        = Join-Path $env:TEMP "bot_support.tar.gz"
$TarExe     = Join-Path $env:SystemRoot "System32\tar.exe"   # bsdtar из Windows

# доп. опции ssh/scp (ключ, если задан)
$sshArgs = @("-p", "$SshPort")
$scpArgs = @("-P", "$SshPort")
if ($SshKey -ne "") {
  $sshArgs += @("-i", $SshKey)
  $scpArgs += @("-i", $SshKey)
}

# .env НЕ пакуем: на сервере лежит боевой конфиг (пароль БД, PUBLIC_URL с доменом),
# и локальный файл его бы затёр. Настройки сервера правятся на сервере.
Write-Host "==> Пакую проект (без node_modules / support.db / .claude / .env / .git)..." -ForegroundColor Green
if (Test-Path $Tar) { Remove-Item $Tar -Force }
Push-Location $ProjectDir
try {
  & $TarExe "--exclude=*node_modules*" "--exclude=*support.db*" "--exclude=*.claude*" `
            "--exclude=*.tar.gz" "--exclude=./.env" "--exclude=.env" `
            "--exclude=./.git" "--exclude=.git" -czf $Tar .
} finally { Pop-Location }
if (-not (Test-Path $Tar)) { throw "Не удалось создать архив $Tar" }
Write-Host ("    архив: {0} ({1:N1} КБ)" -f $Tar, ((Get-Item $Tar).Length / 1KB))

Write-Host "==> Копирую архив на сервер..." -ForegroundColor Green
& scp @scpArgs $Tar "${Server}:~/bot_support.tar.gz"
if ($LASTEXITCODE -ne 0) { throw "scp завершился с ошибкой ($LASTEXITCODE)" }

Write-Host "==> Распаковываю и запускаю установку на сервере..." -ForegroundColor Green
Write-Host "    (сервер попросит sudo-пароль — это нормально)" -ForegroundColor DarkGray
$remote = 'mkdir -p ~/bot_support && ' +
          'tar -xzf ~/bot_support.tar.gz -C ~/bot_support && ' +
          'sed -i ''s/\r$//'' ~/bot_support/deploy/setup-server.sh && ' +
          'chmod +x ~/bot_support/deploy/setup-server.sh && ' +
          'bash ~/bot_support/deploy/setup-server.sh'
# -t : выделить терминал, чтобы sudo мог спросить пароль
& ssh -t @sshArgs $Server $remote
if ($LASTEXITCODE -ne 0) { throw "Установка на сервере завершилась с ошибкой ($LASTEXITCODE)" }

Write-Host "==> Готово. Адрес веб-панели напечатан выше (строка с trycloudflare.com)." -ForegroundColor Green
