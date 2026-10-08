#!/usr/bin/env bash
# ============================================================
#  Пересобирает deploy/install-on-server.sh — самодостаточный установщик:
#  шапка + архив кода в base64 + серверная часть из deploy/setup-server.sh.
#
#  Запуск из любой папки (на Windows — в Git Bash):
#      bash deploy/build-installer.sh
#
#  В архив кладём только файлы приложения, ЯВНЫМ списком. Раньше установщик
#  собирали руками, и внутрь уехал .env с токеном бота.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=deploy/install-on-server.sh
FILES=(index.js config.js package.json package-lock.json bot db web)

for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "Нет $f — запускай из проекта bot_support"; exit 1; }
done

{
  cat <<'HEAD'
#!/usr/bin/env bash
# ============================================================
#  bot_support — САМОДОСТАТОЧНЫЙ установщик для сервера (Ubuntu/Debian)
#  Код проекта зашит внутри (base64). Запускать ПРЯМО НА СЕРВЕРЕ:
#      bash install-on-server.sh
#  Ставит Node 20, PostgreSQL, поднимает бот + веб-панель через systemd;
#  пока нет постоянного домена — ещё и Cloudflare-туннель.
#  Файл генерируется: bash deploy/build-installer.sh — руками не править.
#  Секретов внутри нет: токен бота установщик спросит сам.
# ============================================================
set -euo pipefail
APP_DIR="$HOME/bot_support"
mkdir -p "$APP_DIR"
echo "==> Распаковываю встроенный код в $APP_DIR ..."
base64 -d > /tmp/bs_payload.tgz <<'PAYLOAD_EOF'
HEAD
  tar -czf - --owner=0 --group=0 --exclude='*.tar.gz' "${FILES[@]}" | base64 -w 76
  cat <<'MID'
PAYLOAD_EOF
tar -xzf /tmp/bs_payload.tgz -C "$APP_DIR"
rm -f /tmp/bs_payload.tgz

set -euo pipefail
MID
  # Серверная часть — setup-server.sh после его шапки (всё ниже первого set -euo pipefail)
  sed -n '/^set -euo pipefail$/,$p' deploy/setup-server.sh | tail -n +2
} > "$OUT"

echo "Готово: $OUT ($(wc -c < "$OUT") байт)"
