#!/usr/bin/env bash
# PingUp 2.0 → 2.1 updater: backup, migration, code, services, web limits, verification.
#
#   sudo bash update.sh                         # run from the unpacked 2.1 release (PingUp/update.sh)
#   sudo bash update.sh pingup-php-2.1.0-postgresql.zip
#   sudo bash update.sh --rollback /var/backups/pingup/<run>   # back to 2.0 from that run's backup
#
# Options: --app-dir DIR (default: detected, usually /var/www/pingup), --backup-root DIR
# (default /var/backups/pingup), --yes (no confirmation), --check (preflight only, changes nothing),
# --skip-web (do not touch Nginx/PHP-FPM limits), --force (redeploy code over an existing 2.1).
# Order: preflight → DB dump + code archive → migration (2.0 keeps serving, schema 5 is additive)
# → code replacement in place → PHP-FPM reload → mail worker + cleanup timer → doctor + HTTP check.
# Any failure before the code is replaced leaves 2.0 running; a failure while replacing it restores 2.0 code.
set -Eeuo pipefail
umask 027
export LC_ALL=C

TARGET_VERSION="2.1.0"
APP_DIR=""; BACKUP_ROOT="/var/backups/pingup"; ASSUME_YES=0; CHECK_ONLY=0; SKIP_WEB=0; FORCE=0
ROLLBACK_DIR=""; SOURCE=""

c_red=$'\e[31m'; c_grn=$'\e[32m'; c_ylw=$'\e[33m'; c_bld=$'\e[1m'; c_off=$'\e[0m'
[ -t 1 ] || { c_red=""; c_grn=""; c_ylw=""; c_bld=""; c_off=""; }
LOG_FILE=""
log()  { printf '%s\n' "$*"; [ -z "$LOG_FILE" ] || printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE"; }
step() { log ""; log "${c_bld}==> $*${c_off}"; }
ok()   { log "  ${c_grn}✔${c_off} $*"; }
warn() { log "  ${c_ylw}!${c_off} $*"; WARNINGS+=("$*"); }
die()  { log "${c_red}✖ $*${c_off}"; exit 1; }
WARNINGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --app-dir) APP_DIR="${2:?}"; shift 2 ;;
    --backup-root) BACKUP_ROOT="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --skip-web) SKIP_WEB=1; shift ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK_DIR="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) die "Unknown option $1 (see --help)" ;;
    *) SOURCE="$1"; shift ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash $0 $*"
if ! { exec 9>/run/pingup-update.lock; } 2>/dev/null; then exec 9>/tmp/pingup-update.lock; fi
flock -n 9 || die "Another update.sh is already running."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAS_SYSTEMD=0; [ -d /run/systemd/system ] && command -v systemctl >/dev/null && HAS_SYSTEMD=1
TMP_DIR="$(mktemp -d /tmp/pingup-update.XXXXXX)"
STAGE_DIR=""
cleanup_tmp() { rm -rf "$TMP_DIR"; [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"; }
trap cleanup_tmp EXIT

svc_exists() { [ "$HAS_SYSTEMD" = 1 ] && systemctl cat "$1" >/dev/null 2>&1; }
svc_active() { [ "$HAS_SYSTEMD" = 1 ] && systemctl is-active --quiet "$1"; }
to_bytes() { # 20m / 16M / 1g / 1048576 → bytes
  local v="${1,,}" n; v="${v// /}"; n="${v%[kmg]}"; [[ "$n" =~ ^[0-9]+$ ]] || { echo 0; return; }
  case "$v" in *k) echo $((n*1024));; *m) echo $((n*1048576));; *g) echo $((n*1073741824));; *) echo "$n";; esac
}
confirm() { [ "$ASSUME_YES" = 1 ] && return 0; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[YyДд] ]]; }
apt_install() { command -v apt-get >/dev/null || return 1; DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >>"${LOG_FILE:-/dev/null}" 2>&1; }

# ---------------------------------------------------------------- application discovery
detect_app_dir() {
  local c dir
  if [ -n "$APP_DIR" ]; then echo "${APP_DIR%/}"; return; fi
  if svc_exists pingup-push; then
    dir="$(systemctl show -p WorkingDirectory --value pingup-push 2>/dev/null || true)"
    [ -n "$dir" ] && [ -f "$dir/src/bootstrap.php" ] && { echo "${dir%/}"; return; }
  fi
  if command -v nginx >/dev/null; then
    while read -r c; do
      dir="${c%/public}"; [ -f "$dir/src/bootstrap.php" ] && [ -f "$dir/VERSION" ] && { echo "$dir"; return; }
    done < <(nginx -T 2>/dev/null | sed -nE 's/^\s*root\s+([^;]+)\/?;.*/\1/p' | sed 's:/*$::' | sort -u)
  fi
  for c in /var/www/pingup /var/www/pingup/current /srv/pingup /opt/pingup; do
    [ -f "$c/src/bootstrap.php" ] && { echo "$c"; return; }
  done
  echo ""
}

# PHP helper: imports PINGUP_* variables from PHP-FPM pools and the push unit (as the web server sees them),
# loads config.php and reports DB/storage facts as KEY=base64 lines. Passwords never reach the terminal.
write_probe() {
  cat >"$TMP_DIR/probe.php" <<'PHP'
<?php
declare(strict_types=1);
$app = $argv[1]; $out = [];
$imported = [];
$set = static function (string $k, string $v) use (&$imported): void {
    if (!str_starts_with($k, 'PINGUP_') || getenv($k) !== false) return;
    putenv("$k=$v"); $imported[$k] = $v;
};
foreach (array_merge(glob('/etc/php/*/fpm/pool.d/*.conf') ?: [], glob('/etc/php-fpm.d/*.conf') ?: []) as $pool) {
    foreach (file($pool, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        if (preg_match('/^\s*env\[(PINGUP_[A-Z0-9_]+)\]\s*=\s*(.*?)\s*$/', $line, $m)) $set($m[1], trim($m[2], "\"'"));
    }
}
$unit = (string)@shell_exec('systemctl cat pingup-push 2>/dev/null');
foreach (preg_split('/\R/', $unit) as $line) {
    if (preg_match('/^\s*EnvironmentFile=-?(\S+)/', $line, $m) && is_readable($m[1])) {
        foreach (file($m[1], FILE_IGNORE_NEW_LINES) ?: [] as $l) if (preg_match('/^\s*(?:export\s+)?(PINGUP_[A-Z0-9_]+)=(.*)$/', $l, $e)) $set($e[1], trim($e[2], "\"'"));
    } elseif (preg_match('/^\s*Environment=(.*)$/', $line, $m)) {
        preg_match_all('/"([^"]*)"|(\S+)/', $m[1], $parts);
        foreach ($parts[0] as $p) { $p = trim($p, '"'); if (str_contains($p, '=')) { [$k, $v] = explode('=', $p, 2); $set($k, $v); } }
    }
}
$config = require $app . '/config.php';
$dsn = (string)$config['database_dsn'];
$params = [];
foreach (explode(';', preg_replace('/^pgsql:/', '', $dsn)) as $pair) {
    if (str_contains($pair, '=')) { [$k, $v] = explode('=', $pair, 2); $params[strtolower(trim($k))] = trim($v); }
}
$out['PGHOST'] = $params['host'] ?? ''; $out['PGPORT'] = $params['port'] ?? '5432';
$out['PGDATABASE'] = $params['dbname'] ?? ''; $out['PGUSER'] = (string)$config['database_user'];
$out['PGPASSWORD'] = (string)$config['database_password'];
foreach (['sslmode' => 'PGSSLMODE', 'sslrootcert' => 'PGSSLROOTCERT', 'sslcert' => 'PGSSLCERT', 'sslkey' => 'PGSSLKEY'] as $k => $env) $out[$env] = $params[$k] ?? '';
$out['STORAGE'] = rtrim((string)$config['storage_path'], '/');
$out['UPLOADS'] = rtrim((string)$config['upload_dir'], '/');
$out['ORIGIN'] = (string)($config['app_origin'] ?: ($config['app_url'] ?? ''));
$out['SMTP'] = (!empty($config['smtp_host']) && !empty($config['mail_from'])) ? '1' : '0';
$out['IMPORTED'] = implode(' ', array_keys($imported));
foreach ($imported as $k => $v) $out['ENV_' . $k] = $v;
try {
    $pdo = new PDO($dsn, (string)$config['database_user'], (string)$config['database_password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $out['DB_OK'] = '1';
    $out['SCHEMA'] = (string)($pdo->query("SELECT to_regclass('public.schema_migrations')")->fetchColumn() ? $pdo->query('SELECT MAX(version) FROM schema_migrations')->fetchColumn() : '0');
    $out['DB_SIZE'] = (string)$pdo->query('SELECT pg_database_size(current_database())')->fetchColumn();
    $out['PG_MAJOR'] = (string)intdiv((int)$pdo->query('SHOW server_version_num')->fetchColumn(), 10000);
    $out['USERS'] = (string)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    $out['MESSAGES'] = (string)$pdo->query('SELECT COUNT(*) FROM messages')->fetchColumn();
} catch (Throwable $e) {
    $out['DB_OK'] = '0'; $out['DB_ERROR'] = get_class($e) . ' ' . preg_replace('/password=\S+/i', 'password=***', $e->getMessage());
}
foreach ($out as $k => $v) echo $k, '=', base64_encode((string)$v), "\n";
PHP
}
declare -A P
run_probe() {
  local line
  P=()
  while IFS= read -r line; do [[ "$line" == *=* ]] || continue; P["${line%%=*}"]="$(printf '%s' "${line#*=}" | base64 -d)"; done < <("$PHP_BIN" "$TMP_DIR/probe.php" "$APP_DIR")
  [ -n "${P[PGDATABASE]:-}" ] || die "Could not read the database settings from $APP_DIR/config.php."
  for line in ${P[IMPORTED]}; do export "$line=${P[ENV_$line]}"; done
  export PGHOST="${P[PGHOST]}" PGPORT="${P[PGPORT]}" PGDATABASE="${P[PGDATABASE]}" PGUSER="${P[PGUSER]}" PGPASSWORD="${P[PGPASSWORD]}"
  for line in PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do [ -z "${P[$line]}" ] && unset "$line" || export "$line=${P[$line]}"; done
}

find_pg_tool() { # newest pg_dump/pg_restore whose major >= server major
  local tool="$1" need="$2" cand best="" bestv=0 v
  for cand in /usr/lib/postgresql/*/bin/"$tool" /usr/pgsql-*/bin/"$tool" "$(command -v "$tool" 2>/dev/null || true)"; do
    [ -x "$cand" ] || continue
    v="$("$cand" --version 2>/dev/null | sed -nE 's/.* ([0-9]+)(\.[0-9]+)*.*/\1/p' | head -1)"
    [ -n "$v" ] && [ "$v" -ge "$need" ] && [ "$v" -gt "$bestv" ] && { best="$cand"; bestv="$v"; }
  done
  echo "$best"
}

as_app() { runuser -u "$RUN_USER" -- "$@"; }

php_fpm_services() { [ "$HAS_SYSTEMD" = 1 ] || return 0; systemctl list-units --type=service --state=active --no-legend 'php*-fpm*' 2>/dev/null | awk '{print $1}'; }
reload_php() {
  local s pidf any=0
  for s in $(php_fpm_services); do systemctl reload "$s" 2>/dev/null || systemctl restart "$s"; ok "Reloaded $s (OPcache cleared)"; any=1; done
  if [ "$any" = 0 ]; then # no systemd: signal running FPM masters directly (USR2 = graceful reload)
    for pidf in /run/php/php*-fpm.pid /run/php-fpm/php-fpm.pid /var/run/php-fpm.pid; do
      [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && kill -USR2 "$(cat "$pidf")" && { ok "Reloaded PHP-FPM ($pidf)"; any=1; }
    done
  fi
  for s in apache2 httpd; do
    if svc_active "$s" && { apachectl -M 2>/dev/null | grep -q php; }; then systemctl reload "$s"; ok "Reloaded $s (mod_php)"; any=1; fi
  done
  [ "$any" = 1 ] || warn "No PHP-FPM service found to reload: restart your PHP process manually so OPcache drops 2.0 code."
  sleep 2
}

# ---------------------------------------------------------------- rollback mode
if [ -n "$ROLLBACK_DIR" ]; then
  ROLLBACK_DIR="${ROLLBACK_DIR%/}"
  [ -f "$ROLLBACK_DIR/state.env" ] && [ -f "$ROLLBACK_DIR/database-2.0.dump" ] && [ -f "$ROLLBACK_DIR/code-2.0.tgz" ] || die "$ROLLBACK_DIR is not a backup made by update.sh."
  # shellcheck disable=SC1091
  . "$ROLLBACK_DIR/state.env"
  LOG_FILE="$ROLLBACK_DIR/rollback.log"
  PHP_BIN="${PHP_BIN:-$(command -v php)}"
  write_probe; run_probe
  [ "${P[DB_OK]}" = 1 ] || die "Database connection failed: ${P[DB_ERROR]:-}"
  step "Rollback to 2.0 from $ROLLBACK_DIR"
  log "  Application: $APP_DIR, database: $PGDATABASE@${PGHOST:-local}. Everything written after the update ($UPDATED_AT) will be lost."
  log "  The current 2.1 database is dumped first to $ROLLBACK_DIR/database-2.1-before-rollback.dump."
  confirm "Restore PingUp 2.0 code and database?" || die "Cancelled."
  PG_DUMP="$(find_pg_tool pg_dump "${P[PG_MAJOR]}")"; PG_RESTORE="$(find_pg_tool pg_restore "${P[PG_MAJOR]}")"
  [ -n "$PG_DUMP" ] && [ -n "$PG_RESTORE" ] || die "pg_dump/pg_restore ${P[PG_MAJOR]}+ not found."
  for s in pingup-push pingup-mail pingup-cleanup.timer; do svc_active "$s" && systemctl stop "$s" && ok "Stopped $s"; done
  "$PG_DUMP" --format=custom --file="$ROLLBACK_DIR/database-2.1-before-rollback.dump" && ok "Safety dump of the 2.1 database"
  "$PHP_BIN" -r '$c=require $argv[1]."/config.php"; $p=new PDO($c["database_dsn"],$c["database_user"],$c["database_password"],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]); $p->exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");' "$APP_DIR" \
    || die "Could not reset schema public (the role must own it). Nothing was restored; 2.1 data is in the safety dump."
  if ! "$PG_RESTORE" --exit-on-error --no-owner --dbname="$PGDATABASE" "$ROLLBACK_DIR/database-2.0.dump" >>"$LOG_FILE" 2>&1; then
    die "pg_restore failed (see $LOG_FILE). Restore manually: pg_restore --clean --dbname=$PGDATABASE $ROLLBACK_DIR/database-2.0.dump"
  fi
  ok "Database restored to 2.0 (schema 4)"
  mkdir -p "$TMP_DIR/code"; tar -C "$TMP_DIR/code" -xzf "$ROLLBACK_DIR/code-2.0.tgz"
  OLD="$TMP_DIR/code/$(basename "$APP_DIR")"
  ( cd "$APP_DIR" && find . -path ./storage -prune -o \( -type f -o -type l \) -print ) | while read -r f; do
    [ "$f" = ./config.local.php ] && continue
    [ -e "$OLD/$f" ] || [ -L "$OLD/$f" ] || rm -f "$APP_DIR/$f"
  done
  ( cd "$OLD" && tar --exclude=./storage -cf - . ) | ( cd "$APP_DIR" && tar -xpf - )
  find "$APP_DIR" -path "$APP_DIR/storage" -prune -o -type d -empty -print -delete >/dev/null 2>&1 || true
  ok "Code restored to $(cat "$APP_DIR/VERSION")"
  if [ "$HAS_SYSTEMD" = 1 ]; then
    for s in pingup-mail pingup-cleanup.timer; do systemctl disable --now "$s" >/dev/null 2>&1 || true; done
    rm -f /etc/systemd/system/pingup-mail.service /etc/systemd/system/pingup-cleanup.service /etc/systemd/system/pingup-cleanup.timer
    systemctl daemon-reload
  fi
  rm -f /etc/cron.d/pingup
  reload_php
  svc_exists pingup-push && systemctl start pingup-push && ok "Started pingup-push"
  log ""; log "${c_grn}PingUp 2.0 restored.${c_off} Nginx/PHP upload limits raised by the update were left in place (harmless for 2.0)."
  exit 0
fi

# ---------------------------------------------------------------- preflight
step "Preflight"
APP_DIR="$(detect_app_dir)"
[ -n "$APP_DIR" ] && [ -f "$APP_DIR/src/bootstrap.php" ] || die "PingUp installation not found. Pass it explicitly: --app-dir /var/www/pingup"
APP_DIR="$(cd "$APP_DIR" && pwd -P)"
INSTALLED="$(tr -d '[:space:]' <"$APP_DIR/VERSION" 2>/dev/null || echo unknown)"
ok "Installation: $APP_DIR (version $INSTALLED)"
[ -f "$APP_DIR/config.local.php" ] || warn "No config.local.php: settings come from the environment (imported from PHP-FPM / systemd)."

# Release source: unpacked directory next to this script, a ZIP argument, or a ZIP next to the script.
RELEASE=""
if [ -n "$SOURCE" ] && [ -d "$SOURCE" ]; then RELEASE="$(cd "$SOURCE" && pwd)"; [ -f "$RELEASE/PingUp/VERSION" ] && RELEASE="$RELEASE/PingUp"
elif [ -z "$SOURCE" ] && [ -f "$SCRIPT_DIR/VERSION" ] && [ -f "$SCRIPT_DIR/src/bootstrap.php" ] && [ "$SCRIPT_DIR" != "$APP_DIR" ]; then RELEASE="$SCRIPT_DIR"
else
  [ -n "$SOURCE" ] || SOURCE="$(ls -1t "$SCRIPT_DIR"/pingup-php-2.1*.zip "$PWD"/pingup-php-2.1*.zip 2>/dev/null | head -1 || true)"
  [ -n "$SOURCE" ] && [ -f "$SOURCE" ] || die "Release not found. Usage: sudo bash update.sh pingup-php-${TARGET_VERSION}-postgresql.zip"
  command -v unzip >/dev/null || apt_install unzip || true
  mkdir -p "$TMP_DIR/release"
  if command -v unzip >/dev/null; then unzip -q "$SOURCE" -d "$TMP_DIR/release"; else python3 -m zipfile -e "$SOURCE" "$TMP_DIR/release"; fi
  RELEASE="$TMP_DIR/release/PingUp"
fi
[ -f "$RELEASE/VERSION" ] && [ "$(tr -d '[:space:]' <"$RELEASE/VERSION")" = "$TARGET_VERSION" ] || die "$RELEASE is not a PingUp $TARGET_VERSION release."
( cd "$RELEASE" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1 ) || die "Release archive is damaged: SHA256SUMS mismatch."
ok "Release $TARGET_VERSION verified (SHA256SUMS)"

PHP_BIN=""
if svc_exists pingup-push; then PHP_BIN="$(systemctl show -p ExecStart --value pingup-push 2>/dev/null | sed -nE 's/.*path=([^ ;]+).*/\1/p' | head -1)"; fi
case "$PHP_BIN" in *php*) ;; *) PHP_BIN="$(command -v php || true)" ;; esac
[ -x "$PHP_BIN" ] || die "PHP CLI not found."
PHP_VER="$("$PHP_BIN" -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;')"
"$PHP_BIN" -r 'exit(PHP_VERSION_ID>=80200?0:1);' || die "PHP $PHP_VER is too old: 8.2+ required (8.3 recommended)."
ok "PHP $PHP_VER ($PHP_BIN)"
missing=()
for ext in pdo_pgsql fileinfo mbstring session json openssl curl; do "$PHP_BIN" -r "exit(extension_loaded('$ext')?0:1);" || missing+=("$ext"); done
"$PHP_BIN" -r "exit(extension_loaded('zip')?0:1);" || missing+=("zip?")
if [ ${#missing[@]} -gt 0 ] && [ "$CHECK_ONLY" = 0 ]; then
  pkgs=()
  for ext in "${missing[@]}"; do case "$ext" in pdo_pgsql) pkgs+=("php$PHP_VER-pgsql");; mbstring|curl) pkgs+=("php$PHP_VER-$ext");; "zip?") pkgs+=("php$PHP_VER-zip");; esac; done
  [ ${#pkgs[@]} -eq 0 ] || { apt_install "${pkgs[@]}" && ok "Installed ${pkgs[*]}" || true; }
fi
for ext in pdo_pgsql fileinfo mbstring session json openssl curl; do "$PHP_BIN" -r "exit(extension_loaded('$ext')?0:1);" || die "PHP extension $ext is missing (install php$PHP_VER-${ext/pdo_/})."; done
"$PHP_BIN" -r "exit(extension_loaded('zip')?0:1);" || warn "PHP zip extension missing: Office files are checked by signature only (apt install php$PHP_VER-zip)."
ok "PHP extensions"

write_probe; run_probe
[ "${P[DB_OK]}" = 1 ] || die "Cannot connect to PostgreSQL with the application settings: ${P[DB_ERROR]:-unknown error}"
[ -z "${P[IMPORTED]}" ] || ok "Imported settings from the server environment: ${P[IMPORTED]}"
SCHEMA="${P[SCHEMA]}"
ok "PostgreSQL ${P[PG_MAJOR]}: $PGDATABASE@${PGHOST:-local socket}, schema $SCHEMA, ${P[USERS]} users, ${P[MESSAGES]} messages, $(( ${P[DB_SIZE]} / 1048576 )) MB"
case "$SCHEMA" in
  4) ;;
  5) if [ "$INSTALLED" = "$TARGET_VERSION" ] && [ "$FORCE" = 0 ]; then log "${c_grn}PingUp is already $TARGET_VERSION with schema 5. Nothing to do (use --force to redeploy the code).${c_off}"; exit 0; fi
     warn "Schema is already 5 (an earlier run migrated it): the migration step will be a no-op." ;;
  *) die "Unsupported schema version $SCHEMA: this updater expects PingUp 2.0 (schema 4)." ;;
esac
STORAGE="${P[STORAGE]}"
[ -d "$STORAGE" ] || die "Storage directory $STORAGE does not exist."
RUN_USER="$(stat -c %U "$STORAGE")"; RUN_GROUP="$(stat -c %G "$STORAGE")"
if svc_exists pingup-push; then u="$(systemctl show -p User --value pingup-push)"; [ -n "$u" ] && RUN_USER="$u"; g="$(systemctl show -p Group --value pingup-push)"; [ -n "$g" ] && RUN_GROUP="$g"; fi
[ "$RUN_USER" != root ] || warn "Storage belongs to root; PHP normally runs as www-data. Check permissions after the update."
ok "Private storage: $STORAGE (owner $RUN_USER:$RUN_GROUP)"
REF_FILE="$APP_DIR/public/api.php"; REF_DIR="$APP_DIR/src"
CODE_OWNER="$(stat -c %U "$REF_FILE")"; CODE_GROUP="$(stat -c %G "$REF_FILE")"
FILE_MODE="$(stat -c %a "$REF_FILE")"; DIR_MODE="$(stat -c %a "$REF_DIR")"
ok "Code permissions kept: $CODE_OWNER:$CODE_GROUP, files $FILE_MODE, directories $DIR_MODE"

PG_DUMP="$(find_pg_tool pg_dump "${P[PG_MAJOR]}")"
if [ -z "$PG_DUMP" ] && [ "$CHECK_ONLY" = 0 ]; then apt_install "postgresql-client-${P[PG_MAJOR]}" || true; PG_DUMP="$(find_pg_tool pg_dump "${P[PG_MAJOR]}")"; fi
[ -n "$PG_DUMP" ] || die "pg_dump ${P[PG_MAJOR]}+ is required for the backup (apt install postgresql-client-${P[PG_MAJOR]})."
ok "Backup tool: $PG_DUMP"

if [ -f "$APP_DIR/SHA256SUMS" ]; then
  mapfile -t MODIFIED < <(cd "$APP_DIR" && grep -v "  storage/" SHA256SUMS | sha256sum -c --quiet - 2>/dev/null | sed -nE 's/^(.*): FAILED.*/\1/p')
  [ ${#MODIFIED[@]} -eq 0 ] && ok "No local changes in 2.0 files" || warn "Locally modified 2.0 files will be replaced (kept in the backup): ${MODIFIED[*]}"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/2.1-update-$STAMP"
mkdir -p "$BACKUP_ROOT"
need_kb=$(( ${P[DB_SIZE]} / 1024 + $(du -sk --exclude=storage "$APP_DIR" | awk '{print $1}') * 2 + 102400 ))
free_kb="$(df -Pk "$BACKUP_ROOT" | awk 'NR==2{print $4}')"
[ "$free_kb" -gt "$need_kb" ] || die "Not enough disk space in $BACKUP_ROOT: need ~$((need_kb/1024)) MB, free $((free_kb/1024)) MB."
ok "Disk space for the backup: $((free_kb/1024)) MB free"

if [ "$CHECK_ONLY" = 1 ]; then
  log ""; log "${c_grn}Preflight passed.${c_off} Nothing was changed (--check)."; exit 0
fi
log ""
log "  The update will: dump the database and code to $BACKUP_DIR, migrate PostgreSQL 4 → 5,"
log "  replace the code in $APP_DIR (config.local.php and storage stay), reload PHP, install the mail worker and"
log "  cleanup timer, adjust Nginx/PHP upload limits if they are too small, then verify. Downtime: a few seconds."
confirm "Update PingUp $INSTALLED → $TARGET_VERSION now?" || die "Cancelled."

mkdir -m 700 "$BACKUP_DIR"
LOG_FILE="$BACKUP_DIR/update.log"
log "PingUp update $INSTALLED → $TARGET_VERSION, app $APP_DIR"

# ---------------------------------------------------------------- backup
step "Backup"
"$PG_DUMP" --format=custom --file="$BACKUP_DIR/database-2.0.dump" 2>>"$LOG_FILE" || die "pg_dump failed (see $LOG_FILE). Nothing was changed."
PG_RESTORE="$(find_pg_tool pg_restore "${P[PG_MAJOR]}")"
[ -z "$PG_RESTORE" ] || "$PG_RESTORE" --list "$BACKUP_DIR/database-2.0.dump" >/dev/null || die "The database dump is unreadable. Nothing was changed."
ok "Database: database-2.0.dump ($(du -h "$BACKUP_DIR/database-2.0.dump" | cut -f1))"
STORAGE_REL=""; case "$STORAGE/" in "$APP_DIR"/*) STORAGE_REL="${STORAGE#"$APP_DIR"/}";; esac
tar -C "$(dirname "$APP_DIR")" -czf "$BACKUP_DIR/code-2.0.tgz" ${STORAGE_REL:+--exclude="$(basename "$APP_DIR")/$STORAGE_REL"} "$(basename "$APP_DIR")"
ok "Code and config.local.php: code-2.0.tgz (user files in storage are not touched by the update)"
for f in vapid.json app-secret.key; do [ -f "$STORAGE/$f" ] && cp -p "$STORAGE/$f" "$BACKUP_DIR/" ; done
cat >"$BACKUP_DIR/state.env" <<EOF
APP_DIR=$(printf '%q' "$APP_DIR")
PHP_BIN=$(printf '%q' "$PHP_BIN")
FROM_VERSION=$(printf '%q' "$INSTALLED")
UPDATED_AT=$(printf '%q' "$(date '+%F %T')")
EOF
cp "$0" "$BACKUP_DIR/update.sh" 2>/dev/null || true
ok "Rollback at any time: sudo bash $BACKUP_DIR/update.sh --rollback $BACKUP_DIR"

# ---------------------------------------------------------------- web server limits (8 MB upload chunks)
if [ "$SKIP_WEB" = 0 ]; then
  step "Web server limits"
  FPM_BIN="$(command -v "php-fpm$PHP_VER" || ls /usr/sbin/php-fpm"$PHP_VER" 2>/dev/null || command -v php-fpm || true)"
  if [ -n "$FPM_BIN" ]; then
    fpm_info="$("$FPM_BIN" -i 2>/dev/null || true)"
    pms="$(sed -nE 's/^post_max_size => ([^ ]+).*/\1/p' <<<"$fpm_info" | head -1)"
    umf="$(sed -nE 's/^upload_max_filesize => ([^ ]+).*/\1/p' <<<"$fpm_info" | head -1)"
    if [ "$(to_bytes "${pms:-0}")" -lt $((10*1048576)) ] || [ "$(to_bytes "${umf:-0}")" -lt $((9*1048576)) ]; then
      INI_DIR="/etc/php/$PHP_VER/fpm/conf.d"
      if [ -d "$INI_DIR" ]; then
        printf '; PingUp 2.1: uploads arrive in 8 MB chunks\nupload_max_filesize = 16M\npost_max_size = 20M\n' >"$INI_DIR/90-pingup.ini"
        chmod 644 "$INI_DIR/90-pingup.ini"
        ok "PHP-FPM: post_max_size ${pms:-?} → 20M, upload_max_filesize ${umf:-?} → 16M ($INI_DIR/90-pingup.ini)"
      else warn "PHP-FPM post_max_size=${pms:-?}, upload_max_filesize=${umf:-?}: set post_max_size ≥ 20M and upload_max_filesize ≥ 16M manually."; fi
    else ok "PHP-FPM limits fine (post_max_size $pms, upload_max_filesize $umf)"; fi
    if grep -rqsE 'php_(admin_)?value\[(post_max_size|upload_max_filesize)\]' /etc/php/"$PHP_VER"/fpm/pool.d/ 2>/dev/null; then
      warn "A PHP-FPM pool overrides post_max_size/upload_max_filesize: make sure they are ≥ 20M/16M."
    fi
  else warn "php-fpm$PHP_VER not found; ensure post_max_size ≥ 20M and upload_max_filesize ≥ 16M for the web PHP."; fi

  if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then
    mapfile -t NGX_FILES < <(nginx -T 2>/dev/null | sed -nE 's/^# configuration file (.*):$/\1/p' | while read -r f; do grep -lE "^\s*root\s+$APP_DIR/public/?\s*;" "$f" 2>/dev/null || true; done | xargs -r -n1 readlink -f | sort -u)
    if [ ${#NGX_FILES[@]} -eq 0 ]; then warn "Nginx site for $APP_DIR/public not found: set client_max_body_size 20m manually."
    else
      changed=0
      for f in "${NGX_FILES[@]}"; do
        cp -p "$f" "$BACKUP_DIR/nginx-$(basename "$f").bak"
        if grep -qE '^\s*client_max_body_size\s' "$f"; then
          while read -r val; do
            if [ "$(to_bytes "$val")" -lt $((10*1048576)) ] && [ "$val" != 0 ]; then sed -i -E "s/^(\s*client_max_body_size\s+)$val\s*;/\120m;/" "$f"; changed=1; fi
          done < <(sed -nE 's/^\s*client_max_body_size\s+([^;]+);.*/\1/p' "$f" | sort -u)
        else
          sed -i -E "s|^(\s*)(root\s+$APP_DIR/public/?\s*;.*)$|\1\2\n\1client_max_body_size 20m;|" "$f"; changed=1
        fi
      done
      if [ "$changed" = 1 ]; then
        if nginx -t >>"$LOG_FILE" 2>&1; then { systemctl reload nginx || nginx -s reload; } >>"$LOG_FILE" 2>&1; ok "Nginx: client_max_body_size 20m (${NGX_FILES[*]})"
        else for f in "${NGX_FILES[@]}"; do cp -p "$BACKUP_DIR/nginx-$(basename "$f").bak" "$f"; done; warn "Nginx rejected the change; restored the original. Set client_max_body_size 20m manually."; fi
      else ok "Nginx client_max_body_size is already ≥ 10m"; fi
    fi
  elif command -v nginx >/dev/null; then warn "nginx -t fails before the update; Nginx was not changed."
  fi
fi

# ---------------------------------------------------------------- migration (2.0 keeps serving: schema 5 only adds)
step "Database migration"
STAGE_DIR="$(mktemp -d "$(dirname "$APP_DIR")/.pingup-$TARGET_VERSION-stage.XXXXXX")"
( cd "$RELEASE" && tar --exclude=./storage -cf - . ) | ( cd "$STAGE_DIR" && tar -xf - )
[ -f "$APP_DIR/config.local.php" ] && cp -p "$APP_DIR/config.local.php" "$STAGE_DIR/config.local.php"
chown -R "$CODE_OWNER:$CODE_GROUP" "$STAGE_DIR"; chmod -R u+rwX,g+rX "$STAGE_DIR"; chmod 755 "$STAGE_DIR"
[ "$CODE_GROUP" = "$RUN_GROUP" ] || chmod -R o+rX "$STAGE_DIR"
[ -f "$STAGE_DIR/config.local.php" ] && chmod --reference="$APP_DIR/config.local.php" "$STAGE_DIR/config.local.php" && chown --reference="$APP_DIR/config.local.php" "$STAGE_DIR/config.local.php"
export PINGUP_STORAGE_PATH="${PINGUP_STORAGE_PATH:-$STORAGE}"
svc_active pingup-push && { systemctl stop pingup-push; PUSH_WAS_ACTIVE=1; ok "Stopped pingup-push for the switch"; } || PUSH_WAS_ACTIVE=0
restart_push() { [ "$PUSH_WAS_ACTIVE" = 1 ] && systemctl start pingup-push && ok "Started pingup-push"; return 0; }
if ! as_app "$PHP_BIN" "$STAGE_DIR/bin/migrate.php" >>"$LOG_FILE" 2>&1; then
  restart_push
  tail -n 3 "$LOG_FILE" | sed 's/^/    /'
  die "Migration failed and was rolled back by PostgreSQL. PingUp $INSTALLED keeps running unchanged."
fi
[ "$(as_app "$PHP_BIN" -r 'require $argv[1]."/src/bootstrap.php"; echo (int)query("SELECT MAX(version) FROM schema_migrations")->fetchColumn();' "$STAGE_DIR")" = 5 ] || die "Schema is not 5 after migration."
ok "PostgreSQL schema 4 → 5 (existing data kept; owners, delivery cursors and pins derived)"

# ---------------------------------------------------------------- code replacement
step "Code"
restore_code() {
  log "  Restoring $INSTALLED code…"
  mkdir -p "$TMP_DIR/old"; tar -C "$TMP_DIR/old" -xzf "$BACKUP_DIR/code-2.0.tgz"
  ( cd "$TMP_DIR/old/$(basename "$APP_DIR")" && tar ${STORAGE_REL:+--exclude=./$STORAGE_REL} -cf - . ) | ( cd "$APP_DIR" && tar -xpf - )
  reload_php; restart_push
}
deploy_code() {
  local f
  # Files that 2.0 shipped but 2.1 no longer has (styles.css, experience.css, motion.css, …).
  if [ -f "$APP_DIR/SHA256SUMS" ]; then
    comm -23 <(awk '{print $2}' "$APP_DIR/SHA256SUMS" | sort -u) <(awk '{print $2}' "$STAGE_DIR/SHA256SUMS" | sort -u) | while read -r f; do
      case "$f" in storage/*|config.local.php|""|*..*) continue;; esac
      rm -f "$APP_DIR/$f"
    done
  fi
  ( cd "$STAGE_DIR" && find . -mindepth 1 -type d ) | while read -r f; do install -d -o "$CODE_OWNER" -g "$CODE_GROUP" -m "$DIR_MODE" "$APP_DIR/$f"; done
  ( cd "$STAGE_DIR" && find . -type f ! -name config.local.php ) | while read -r f; do
    install -o "$CODE_OWNER" -g "$CODE_GROUP" -m "$FILE_MODE" "$STAGE_DIR/$f" "$APP_DIR/$f.pingup-new"
    mv -f "$APP_DIR/$f.pingup-new" "$APP_DIR/$f"   # atomic per file
  done
  find "$APP_DIR/public" "$APP_DIR/src" "$APP_DIR/vendor" -type d -empty -delete 2>/dev/null || true
}
if ! deploy_code 2>>"$LOG_FILE"; then restore_code; die "Copying the new code failed (see $LOG_FILE). $INSTALLED code restored; the database stays at schema 5, which $INSTALLED tolerates. Rollback: sudo bash $BACKUP_DIR/update.sh --rollback $BACKUP_DIR"; fi
[ "$(tr -d '[:space:]' <"$APP_DIR/VERSION")" = "$TARGET_VERSION" ] || { restore_code; die "Version check after copy failed."; }
( cd "$APP_DIR" && grep -v "  storage/" SHA256SUMS | sha256sum -c --quiet - >/dev/null 2>&1 ) || { restore_code; die "Installed files do not match SHA256SUMS."; }
ok "$APP_DIR is now $TARGET_VERSION (all files verified; config.local.php and storage untouched)"
reload_php

# ---------------------------------------------------------------- background services
step "Background services"
if [ "$HAS_SYSTEMD" = 1 ]; then
  ENV_LINES="$(systemctl cat pingup-push 2>/dev/null | grep -E '^\s*(Environment|EnvironmentFile)=' || true)"
  unit_from_template() { # $1 template, $2 destination
    sed -e "s|/var/www/pingup/storage|$STORAGE|g" -e "s|/var/www/pingup|$APP_DIR|g" -e "s|/usr/bin/php|$PHP_BIN|g" \
        -e "s|^User=.*|User=$RUN_USER|" -e "s|^Group=.*|Group=$RUN_GROUP|" "$1" >"$2"
    if [ -n "$ENV_LINES" ]; then awk -v env="$ENV_LINES" '{print} /^\[Service\]/{print env}' "$2" >"$2.tmp" && mv "$2.tmp" "$2"; fi
    [ "$STORAGE" = "$APP_DIR/storage" ] || sed -i "s|^ReadWritePaths=.*|ReadWritePaths=$STORAGE|" "$2"
    chmod 644 "$2"
  }
  unit_from_template "$APP_DIR/deploy/pingup-mail.service" /etc/systemd/system/pingup-mail.service
  if grep -rqsF "$APP_DIR/bin/cleanup.php" /etc/cron.d /etc/crontab /var/spool/cron 2>/dev/null; then
    ok "Existing cron job runs bin/cleanup.php; no timer added"
  else
    cat >"$TMP_DIR/cleanup.service" <<EOF
[Unit]
Description=PingUp cleanup (scheduled posts, partial uploads, orphaned files)
After=network-online.target postgresql.service
[Service]
Type=oneshot
User=www-data
Group=www-data
WorkingDirectory=/var/www/pingup
ExecStart=/usr/bin/php /var/www/pingup/bin/cleanup.php
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/www/pingup/storage
EOF
    unit_from_template "$TMP_DIR/cleanup.service" /etc/systemd/system/pingup-cleanup.service
    printf '[Unit]\nDescription=Run PingUp cleanup every 5 minutes\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\nPersistent=true\n[Install]\nWantedBy=timers.target\n' >/etc/systemd/system/pingup-cleanup.timer
    chmod 644 /etc/systemd/system/pingup-cleanup.timer
    systemctl daemon-reload; systemctl enable --now pingup-cleanup.timer >/dev/null 2>&1 && ok "pingup-cleanup.timer every 5 minutes (scheduled posts, uploads)"
  fi
  systemctl daemon-reload
  if [ "${P[SMTP]}" = 1 ]; then
    systemctl enable pingup-mail >/dev/null 2>&1; systemctl restart pingup-mail && ok "pingup-mail started (SMTP outbox)"
  else
    systemctl disable --now pingup-mail >/dev/null 2>&1 || true
    warn "SMTP is not configured: e-mail codes wait in the queue. Add smtp_* and mail_from to config.local.php, then: systemctl enable --now pingup-mail"
  fi
else
  if ! grep -rqsF "$APP_DIR/bin/cleanup.php" /etc/cron.d /etc/crontab /var/spool/cron 2>/dev/null; then
    { [ -z "${P[IMPORTED]}" ] || for k in ${P[IMPORTED]}; do printf '%s=%s\n' "$k" "${P[ENV_$k]}"; done
      printf '*/5 * * * * %s %s %s/bin/cleanup.php >/dev/null 2>&1\n' "$RUN_USER" "$PHP_BIN" "$APP_DIR"; } >/etc/cron.d/pingup
    chmod 600 /etc/cron.d/pingup; ok "Cron /etc/cron.d/pingup: cleanup every 5 minutes"
  fi
  warn "systemd not available: start the mail worker yourself ($PHP_BIN $APP_DIR/bin/mail-worker.php as $RUN_USER)."
fi
restart_push

# ---------------------------------------------------------------- verification
step "Verification"
DOCTOR_OUT="$(as_app "$PHP_BIN" -d upload_max_filesize=16M -d post_max_size=20M "$APP_DIR/bin/doctor.php" 2>&1 || true)"
printf '%s\n' "$DOCTOR_OUT" >>"$LOG_FILE"
printf '%s\n' "$DOCTOR_OUT" | sed 's/^/    /'
grep -q '^\[FAIL\]' <<<"$DOCTOR_OUT" && warn "bin/doctor.php reports problems (above)."
grep -q 'No administrator' <<<"$DOCTOR_OUT" && warn "No administrator yet (needed for feedback and Premium): sudo -u $RUN_USER $PHP_BIN $APP_DIR/bin/create-admin.php --username=admin --name='PingUp Admin'"
if [ -n "${P[ORIGIN]}" ] && command -v curl >/dev/null; then
  host="$(sed -E 's#^[a-z]+://([^/:]+).*#\1#' <<<"${P[ORIGIN]}")"; scheme="${P[ORIGIN]%%://*}"; port=$([ "$scheme" = https ] && echo 443 || echo 80)
  base="${P[ORIGIN]%/}"
  check_http() { curl -fsS --max-time 15 --resolve "$host:$port:127.0.0.1" "$@" 2>/dev/null || curl -fsS --max-time 15 "$@" 2>/dev/null; }
  if check_http "$base/api.php?action=bootstrap" | grep -q "\"version\":\"$TARGET_VERSION\""; then ok "API $TARGET_VERSION answers at $base"; else warn "API check at $base/api.php failed: open the site and look at the PHP-FPM / Nginx error log."; fi
  if check_http "$base/sw.js" | grep -q "$TARGET_VERSION"; then ok "Service Worker $TARGET_VERSION is served (clients show the update button)"; else warn "sw.js at $base is not $TARGET_VERSION yet (CDN cache?)."; fi
else
  warn "app_origin is not set: HTTP check skipped. Open the site and sign in to confirm."
fi

log ""
log "${c_grn}${c_bld}PingUp $TARGET_VERSION is installed.${c_off}"
log "  Backup and log: $BACKUP_DIR"
log "  Rollback to $INSTALLED: sudo bash $BACKUP_DIR/update.sh --rollback $BACKUP_DIR"
log "  Users get the new interface after tapping “Update” in the app (Service Worker)."
if [ ${#WARNINGS[@]} -gt 0 ]; then log ""; log "${c_ylw}Attention:${c_off}"; for w in "${WARNINGS[@]}"; do log "  - $w"; done; fi
