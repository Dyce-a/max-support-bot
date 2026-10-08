#!/usr/bin/env bash
# ============================================================
#  bot_support — серверный установщик (Ubuntu/Debian)
#  Запускается НА СЕРВЕРЕ. Ставит Node.js, PostgreSQL, cloudflared,
#  настраивает автозапуск через systemd; пока нет постоянного домена —
#  поднимает Cloudflare-туннель. Код отсюда же вшит в install-on-server.sh
#  (пересборка: bash deploy/build-installer.sh).
#  Идемпотентен: можно запускать повторно при каждом обновлении.
# ============================================================
set -euo pipefail

APP_NAME="bot-support"
APP_DIR="${APP_DIR:-$HOME/bot_support}"
APP_PORT="3000"
RUN_USER="$(id -un)"
PASS_FILE="$HOME/.bot_support_db_password"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

[ -f "$APP_DIR/index.js" ] || { echo "Не найден $APP_DIR/index.js — код не распакован."; exit 1; }
cd "$APP_DIR"

# --- 0. базовые утилиты ---
log "Обновляю apt и ставлю базовые пакеты"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg openssl

# --- 1. Node.js 20 LTS (если нет или версия < 18) ---
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  [ "${major:-0}" -ge 18 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  log "Ставлю Node.js 20 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
log "Node $(node -v), npm $(npm -v)"

# --- 2. PostgreSQL ---
if ! command -v psql >/dev/null 2>&1; then
  log "Ставлю PostgreSQL"
  sudo apt-get install -y postgresql postgresql-contrib
fi
sudo systemctl enable --now postgresql

# пароль БД: генерим один раз, дальше переиспользуем
if [ -f "$PASS_FILE" ]; then
  DB_PASS="$(cat "$PASS_FILE")"
else
  DB_PASS="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf '%s' "$DB_PASS" > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
fi

log "Создаю роль и базу bot_support (идемпотентно)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bot_support') THEN
    CREATE ROLE bot_support LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE bot_support LOGIN PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='bot_support'" | grep -q 1; then
  sudo -u postgres createdb -O bot_support bot_support
fi
# на PG15+ владельцу БД нужно явно дать права на схему public
sudo -u postgres psql -d bot_support -c "GRANT ALL ON SCHEMA public TO bot_support;" >/dev/null

# --- 3. .env: проставляем PG_* (BOT_TOKEN и PORT не трогаем) ---
log "Обновляю .env (PG_* → локальная база)"
[ -f .env ] || touch .env
set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
set_env PG_HOST localhost
set_env PG_PORT 5432
set_env PG_USER bot_support
set_env PG_PASSWORD "$DB_PASS"
set_env PG_DB bot_support
grep -q "^PORT=" .env || printf 'PORT=%s\n' "$APP_PORT" >> .env

# Токен бота живёт только здесь: в коде его больше нет, и без него сервис не стартует
if ! grep -qE '^BOT_TOKEN=.+' .env; then
  echo
  echo "В .env нет BOT_TOKEN — токена бота из кабинета business.max.ru."
  read -rsp "Вставь токен (ввод скрыт): " NEW_TOKEN </dev/tty || NEW_TOKEN=""
  echo
  if [ -z "$NEW_TOKEN" ]; then
    echo "Без BOT_TOKEN бот не запустится. Пропиши его в $APP_DIR/.env и запусти установку снова."
    exit 1
  fi
  set_env BOT_TOKEN "$NEW_TOKEN"
fi

# Секрет подписи куки: без него сессии подписываются случайным ключом и слетают
# при каждом перезапуске. Генерим один раз — смена разлогинит всех
grep -qE '^SESSION_SECRET=.+' .env || set_env SESSION_SECRET "$(openssl rand -hex 32)"

# В .env токен бота, пароль БД и секрет сессий — читать его должен только владелец.
# Не валим деплой, если файл чужой (например, когда-то создан через sudo)
chmod 600 .env 2>/dev/null || echo "⚠ Не удалось выставить права 600 на .env — поправь руками: sudo chmod 600 $APP_DIR/.env"

# --- 4. зависимости ---
log "Устанавливаю npm-зависимости"
if [ -f package-lock.json ]; then npm ci || npm install; else npm install; fi

# --- 5. cloudflared ---
if ! command -v cloudflared >/dev/null 2>&1; then
  log "Ставлю cloudflared"
  arch="$(dpkg --print-architecture)"   # amd64 / arm64
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb" -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb || sudo apt-get install -f -y
fi

# --- 6. systemd: само приложение (бот + веб-панель) ---
NODE_BIN="$(command -v node)"
log "Создаю systemd-сервис ${APP_NAME}"
sudo tee /etc/systemd/system/${APP_NAME}.service >/dev/null <<UNIT
[Unit]
Description=bot_support (Max-бот заявок + веб-панель)
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

# --- 7. PUBLIC_URL: от него зависят QR-коды и сканер в боте ---
# Если он уже указывает на постоянный домен — не трогаем: иначе каждый деплой
# затирал бы домен временным адресом туннеля, а он зашит в напечатанные QR.
CUR_URL="$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2-)"
case "$CUR_URL" in
  ''|*localhost*|*trycloudflare.com*) KEEP_URL='' ;;
  *)                                  KEEP_URL='yes' ;;
esac

log "Перезапускаю ${APP_NAME}"
sudo systemctl daemon-reload
sudo systemctl enable --now ${APP_NAME}.service
sudo systemctl restart ${APP_NAME}.service

URL=""
if [ -n "$KEEP_URL" ]; then
  # Панель уже открыта по домену. Quick-туннель при этом был лишним входом в неё
  # в обход шлюза вуза — со случайным адресом, но публичным. Выключаем.
  log "PUBLIC_URL — постоянный домен ($CUR_URL): Cloudflare-туннель не нужен, выключаю"
  sudo systemctl disable --now ${APP_NAME}-tunnel.service 2>/dev/null || true
else
  # --- 8. systemd: Cloudflare quick-туннель на localhost:PORT ---
  log "Создаю systemd-сервис ${APP_NAME}-tunnel"
  sudo tee /etc/systemd/system/${APP_NAME}-tunnel.service >/dev/null <<UNIT
[Unit]
Description=Cloudflare Quick Tunnel для bot_support
After=network-online.target ${APP_NAME}.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:${APP_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now ${APP_NAME}-tunnel.service
  sudo systemctl restart ${APP_NAME}-tunnel.service

  # --- 9. достаём публичный адрес туннеля и прописываем его в PUBLIC_URL ---
  # Адрес quick-туннеля меняется при каждом перезапуске
  log "Жду публичный адрес Cloudflare-туннеля (до ~60с)..."
  for _ in $(seq 1 30); do
    URL="$(sudo journalctl -u ${APP_NAME}-tunnel --no-pager -n 200 2>/dev/null \
          | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -n1 || true)"
    [ -n "$URL" ] && break
    sleep 2
  done
  if [ -n "$URL" ]; then
    log "Прописываю PUBLIC_URL=$URL и перезапускаю ${APP_NAME}"
    set_env PUBLIC_URL "$URL"
    sudo systemctl restart ${APP_NAME}.service
  fi
fi

echo
echo "==================================================================="
echo "  ✅ Установка завершена."
echo
echo "  Статус бота:    sudo systemctl status ${APP_NAME}"
echo "  Логи бота:      sudo journalctl -u ${APP_NAME} -f"
if [ -n "$KEEP_URL" ]; then
  echo
  echo "  🌐 Веб-панель:  $CUR_URL"
elif [ -n "$URL" ]; then
  echo "  Статус туннеля: sudo systemctl status ${APP_NAME}-tunnel"
  echo
  echo "  🌐 Веб-панель:  $URL"
else
  echo
  echo "  🌐 Адрес туннеля ещё не появился в логах. Посмотри руками:"
  echo "     sudo journalctl -u ${APP_NAME}-tunnel | grep trycloudflare"
fi
echo "==================================================================="
