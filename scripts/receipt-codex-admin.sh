#!/bin/sh
set -eu
die(){ echo "$1" >&2; exit 2; }
name(){ printf '%s' "$1" | grep -Eq '^[a-z][a-z0-9_]{0,62}$'; }
clone_db(){ case "$1" in finance_receipt_collector_selfservice_e2e_*) name "$1";; *) return 1;; esac; }
clone_role(){ case "$1" in selfservice_e2e_*) name "$1";; *) return 1;; esac; }
state_dir=/run/receipt-codex
db_state=$state_dir/clone-db
role_state=$state_dir/clone-role
exists_db(){ sudo -u postgres psql -X -Atqc "SELECT count(*) FROM pg_database WHERE datname='$1';" -d postgres; }
exists_role(){ sudo -u postgres psql -X -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$1';" -d postgres; }
current_db(){
  [ -r "$db_state" ] || die CAPABILITY_DENIED
  db=$(cat "$db_state")
  clone_db "$db" || die CAPABILITY_DENIED
  [ "$db" != finance_receipt_collector ] || die CAPABILITY_DENIED
  printf '%s' "$db"
}
current_role(){
  [ -r "$role_state" ] || die CAPABILITY_DENIED
  role=$(cat "$role_state")
  clone_role "$role" || die CAPABILITY_DENIED
  printf '%s' "$role"
}
write_state(){
  install -d -o root -g root -m 0700 "$state_dir"
  printf '%s\n' "$1" > "$2.tmp"
  chmod 0600 "$2.tmp"
  mv -f "$2.tmp" "$2"
}
clone_exists(){
  [ -r "$db_state" ] || { printf '0\n'; return; }
  db=$(current_db); [ "$(exists_db "$db")" = 1 ] && printf '1\n' || printf '0\n'
}
role_exists(){
  [ -r "$role_state" ] || { printf '0\n'; return; }
  role=$(current_role); [ "$(exists_role "$role")" = 1 ] && printf '1\n' || printf '0\n'
}
case "${1:-}" in
  capabilities)
    printf 'chromium=%s\n' "$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
    printf 'xrdp=%s\n' "$(command -v xrdp || true)"
    printf 'xorg=%s\n' "$(command -v Xorg || true)"
    printf 'rdp_listeners=%s\n' "$(ss -lnt 2>/dev/null | awk '/:3389 /{print $4}' | paste -sd, -)"
    ;;
  production-identity) sudo -u postgres psql -X -Atqc 'SELECT current_database();' -d finance_receipt_collector ;;
  production-schema) sudo -u postgres psql -X -Atqc "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;" -d finance_receipt_collector ;;
  production-migrations) sudo -u postgres psql -X -Atqc 'SELECT filename FROM schema_migrations ORDER BY filename;' -d finance_receipt_collector ;;
  backup-validate)
    latest=$(find /var/backups/receipt-collector/postgres -maxdepth 1 -type f -name '*.dump.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
    test -n "$latest" || die BACKUP_NOT_FOUND
    gzip -cd "$latest" | sudo -u postgres pg_restore --list >/dev/null
    sha256sum "$latest"
    ;;
  clone-role-create)
    role=${2:-}; clone_role "$role" || die INVALID_ROLE
    IFS= read -r password || die PASSWORD_REQUIRED
    escaped=$(printf '%s' "$password" | sed "s/'/''/g")
    printf 'CREATE ROLE "%s" LOGIN PASSWORD '\''%s'\'';\n' "$role" "$escaped" | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres
    write_state "$role" "$role_state"
    ;;
  clone-role-verify)
    role=${2:-}; clone_role "$role" || die INVALID_ROLE
    [ "$(exists_role "$role")" = 1 ] || die ROLE_NOT_FOUND; printf '%s\n' "$role"
    ;;
  clone-db-create)
    db=${2:-}; role=${3:-}; clone_db "$db" && clone_role "$role" || die INVALID_IDENTIFIER
    [ "$(current_role)" = "$role" ] || die CAPABILITY_DENIED
    sudo -u postgres createdb --owner="$role" "$db"
    write_state "$db" "$db_state"
    ;;
  clone-db-verify)
    db=${2:-}; clone_db "$db" || die INVALID_DATABASE
    [ "$(exists_db "$db")" = 1 ] || die DATABASE_NOT_FOUND; printf '%s\n' "$db"
    ;;
  clone-restore)
    db=${2:-}; clone_db "$db" || die INVALID_DATABASE
    latest=$(find /var/backups/receipt-collector/postgres -maxdepth 1 -type f -name '*.dump.gz' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
    test -n "$latest" || die BACKUP_NOT_FOUND
    gzip -cd "$latest" | sudo -u postgres pg_restore --no-owner --no-privileges --dbname="$db"
    ;;
  clone-grant)
    db=${2:-}; role=${3:-}; clone_db "$db" && clone_role "$role" || die INVALID_IDENTIFIER
    [ "$db" != finance_receipt_collector ] || die PRODUCTION_DATABASE_FORBIDDEN
    sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d "$db" -c "GRANT USAGE, CREATE ON SCHEMA public TO \"$role\"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$role\"; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \"$role\";"
    ;;
  clone-query)
    db=${2:-}; query=${3:-}; clone_db "$db" || die INVALID_DATABASE
    case "$query" in
      identity) sql='SELECT current_database();' ;;
      schema) sql="SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;" ;;
      migrations) sql='SELECT filename FROM schema_migrations ORDER BY filename;' ;;
      *) die QUERY_NOT_ALLOWLISTED ;;
    esac
    sudo -u postgres psql -X -Atqc "$sql" -d "$db"
    ;;
  clone-exists)
    [ "$#" -eq 1 ] || die CAPABILITY_DENIED
    clone_exists
    ;;
  clone-role-exists)
    [ "$#" -eq 1 ] || die CAPABILITY_DENIED
    role_exists
    ;;
  clone-restore-status)
    [ "$#" -eq 1 ] || die CAPABILITY_DENIED
    db=$(current_db)
    [ "$(exists_db "$db")" = 1 ] || die DATABASE_NOT_FOUND
    found=0
    for proc in /proc/[0-9]*; do
      [ -r "$proc/cmdline" ] || continue
      cmdline=$(tr '\000' ' ' < "$proc/cmdline" 2>/dev/null || true)
      case "$cmdline" in
        *pg_restore*"--dbname=$db"*)
          pid=${proc##*/}; found=1
          stat_line=$(cat "$proc/stat" 2>/dev/null || true)
          state=$(printf '%s\n' "$stat_line" | awk '{print $3}')
          utime=$(printf '%s\n' "$stat_line" | awk '{print $14}')
          stime=$(printf '%s\n' "$stat_line" | awk '{print $15}')
          start_ticks=$(printf '%s\n' "$stat_line" | awk '{print $22}')
          hz=$(getconf CLK_TCK 2>/dev/null || printf '100')
          uptime=$(awk '{print $1}' /proc/uptime 2>/dev/null || printf '0')
          elapsed=$(awk -v u="$uptime" -v s="$start_ticks" -v h="$hz" 'BEGIN {v=u-s/h; if(v<0)v=0; printf "%.3f",v}')
          cpu=$(awk -v u="$utime" -v s="$stime" -v h="$hz" 'BEGIN {printf "%.3f",(u+s)/h}')
          read_bytes=$(awk -F: '/^read_bytes:/{gsub(/[[:space:]]/,"",$2); print $2}' "$proc/io" 2>/dev/null || printf 'unavailable')
          write_bytes=$(awk -F: '/^write_bytes:/{gsub(/[[:space:]]/,"",$2); print $2}' "$proc/io" 2>/dev/null || printf 'unavailable')
          printf 'restore_process=present\npid=%s\nstate=%s\nelapsed_seconds=%s\ncpu_seconds=%s\nread_bytes=%s\nwrite_bytes=%s\n' "$pid" "$state" "$elapsed" "$cpu" "$read_bytes" "$write_bytes"
          break
          ;;
      esac
    done
    [ "$found" -eq 1 ] || printf 'restore_process=absent\n'
    sudo -u postgres psql -X -Atq -d "$db" -c "SELECT 'activity='||pid||'|'||state||'|'||coalesce(wait_event_type,'')||'|'||coalesce(wait_event,'')||'|'||extract(epoch from (now()-query_start))::int||'|'||extract(epoch from (now()-xact_start))::int||'|'||left(regexp_replace(coalesce(query,''),'[[:space:]]+',' ','g'),160) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();"
    sudo -u postgres psql -X -Atq -d "$db" -c "SELECT 'locks='||count(*)||'|waiting='||count(*) FILTER (WHERE NOT granted) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database();"
    sudo -u postgres psql -X -Atq -d "$db" -c "SELECT 'objects='||(SELECT count(*) FROM information_schema.tables WHERE table_schema='public')||'|indexes='||(SELECT count(*) FROM pg_class WHERE relkind='i')||'|size_bytes='||pg_database_size(current_database());"
    ;;
  clone-drop)
    db=${2:-}; role=${3:-}; clone_db "$db" && clone_role "$role" || die INVALID_IDENTIFIER
    [ "$(current_db)" = "$db" ] || die CAPABILITY_DENIED
    [ "$(current_role)" = "$role" ] || die CAPABILITY_DENIED
    sudo -u postgres dropdb --if-exists --force "$db"; sudo -u postgres dropuser --if-exists "$role"
    rm -f "$db_state" "$role_state"
    ;;
  *) die CAPABILITY_DENIED ;;
esac
