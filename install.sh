#!/usr/bin/env bash
# 把 serverpulse 装成 systemd 服务（开机自启、崩溃自动重启）。不用改任何文件。
#   sudo bash install.sh              默认装到 /opt/serverpulse，服务名 serverpulse
#   sudo PORT=8123 bash install.sh    换端口
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

PREFIX="${PREFIX:-/opt/serverpulse}"
SERVICE="${SERVICE:-serverpulse}"
PORT_ARG="${PORT:-}"          # 用户显式指定的端口（用于和配置文件不一致时提醒）
PORT="${PORT:-8080}"

# 需要 root：不是的话自动用 sudo 重跑一遍（新手直接 ./install.sh 也行）
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1; then echo "需要管理员权限，自动用 sudo 重跑…"; exec sudo -E bash "$0" "$@"; fi
  echo "请用 root 运行：su -c \"bash $0\""; exit 1
fi

# 依赖检查：说清楚缺什么、怎么补，不自动乱装东西
if ! command -v node >/dev/null 2>&1; then
  echo "这台机器没装 Node.js。先装 Node 18 以上再重跑本脚本："
  echo "  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  echo "  或者下官方包:   https://nodejs.org/en/download"
  exit 1
fi
NODE_BIN="$(command -v node)"
[ "$("$NODE_BIN" -p "process.versions.node.split(\".\")[0]")" -ge 18 ] || { echo "Node 版本太低：$("$NODE_BIN" -v)，需要 18 以上"; exit 1; }
if ! command -v systemctl >/dev/null 2>&1; then
  echo "这台机器没有 systemd，装不成系统服务；改成前台运行：./start.sh"; exit 1
fi
echo "Node $("$NODE_BIN" -v)"

# 端口预检（同一个服务已经在跑就不算占用）
if [ ! -f "$PREFIX/config.json" ] && command -v ss >/dev/null 2>&1 && ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  if ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
    echo "端口 ${PORT} 已被占用：$(ss -ltnp "sport = :${PORT}" 2>/dev/null | tail -1)"
    echo "换个端口重跑：sudo PORT=8123 bash install.sh"
    exit 1
  fi
fi

mkdir -p "$PREFIX"
cp -f monitor.mjs dashboard.html login.html favicon.ico "$PREFIX/"
CFG="$PREFIX/config.json"
if [ ! -f "$CFG" ]; then
  TOKEN="$(openssl rand -hex 16 2>/dev/null || "$NODE_BIN" -e "console.log(require(\"crypto\").randomBytes(16).toString(\"hex\"))")"
  "$NODE_BIN" -e "require(\"fs\").writeFileSync(process.argv[1], JSON.stringify({port:Number(process.argv[2]),host:\"0.0.0.0\",token:process.argv[3],sessionDays:5,intervalMs:2000,label:require(\"os\").hostname()},null,2)+\"\n\")" "$CFG" "$PORT" "$TOKEN"
  chmod 600 "$CFG"
  echo "已生成 $CFG（端口 $PORT，口令随机）"
else
  # 已存在就只用不写：你改过的端口和口令绝不会被覆盖
  CFG_OK="$("$NODE_BIN" -e "try{JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));process.stdout.write(\"1\")}catch(e){process.stdout.write(\"0\")}" "$CFG")"
  if [ "$CFG_OK" != "1" ]; then
    echo "!! $CFG 读不出来（文件损坏或不是合法 JSON）。"
    echo "   这样启动会变成「不需要口令」，所以先停在这里。修好它，或者删掉重建："
    echo "     sudo rm $CFG && sudo bash $0"
    exit 1
  fi
  TOKEN="$("$NODE_BIN" -e "try{process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).token||\"\")}catch(e){}" "$CFG")"
  CFG_PORT="$("$NODE_BIN" -e "try{process.stdout.write(String(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).port||\"\"))}catch(e){}" "$CFG")"
  if [ -n "$PORT_ARG" ] && [ "$PORT_ARG" != "$CFG_PORT" ]; then
    echo "注意：$CFG 里的端口是 $CFG_PORT，本次指定的 $PORT_ARG 不生效（配置优先，不会被改）"
  fi
  if [ -n "$CFG_PORT" ]; then PORT="$CFG_PORT"; fi
  if [ -n "$TOKEN" ]; then
    echo "已有 $CFG：沿用端口 $PORT 和口令 $TOKEN，不会覆盖"
  else
    echo "已有 $CFG：沿用端口 $PORT；注意里面的口令是空的（等于不鉴权）"
  fi
fi
# ---- 服务单元在这里生成，仓库里不再放需要手改路径的模板 ----
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=${SERVICE} - server metrics dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PREFIX}
ExecStart=${NODE_BIN} ${PREFIX}/monitor.mjs
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Nice=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${PREFIX}
# 日志交给 systemd journal（每次启动两行，系统自己轮转，我们不加自己的日志文件）：
#   journalctl -u ${SERVICE} -n 20        想看就翻，不想留可以改成 StandardOutput=null
#StandardOutput=null
#StandardError=null

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
# 用 restart 而不是 --now：已经在跑的话也要重启，否则改过的 config.json 和新拷进去的代码不会生效
systemctl restart "$SERVICE"
# 等它真的能访问（只看 systemd 的 active 不够：进程起来了但端口可能还没监听）
ok=0
if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if systemctl is-active --quiet "$SERVICE" && curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${PORT}/login" 2>/dev/null; then ok=1; break; fi
    sleep 0.5
  done
else
  for _ in 1 2 3 4 5 6; do systemctl is-active --quiet "$SERVICE" && { ok=1; break; }; sleep 1; done
fi
if [ "$ok" != 1 ]; then
  echo; echo "没能正常起来，最近的日志："; echo "----------------------------------------"
  journalctl -u "$SERVICE" -n 20 --no-pager -o cat 2>/dev/null || true
  echo "----------------------------------------"
  echo "常见原因：端口 ${PORT} 被别的程序占用 → 换个端口重跑  sudo PORT=8123 bash install.sh"
  exit 1
fi
IP="$(hostname -I 2>/dev/null | cut -d' ' -f1)"; [ -n "${IP:-}" ] || IP="<服务器IP>"
echo
echo "装好了 ✔  已开机自启，崩了自动重启"
echo "  面板地址  http://${IP}:${PORT}/        （公网访问换成公网 IP 或域名）"
echo "  登录口令  ${TOKEN:-（未设置，任何人可访问）}"
echo "  看日志    journalctl -u ${SERVICE} -f   口令也打在这里（不想留日志就把它设成 StandardOutput=null）"
echo "  重启      systemctl restart ${SERVICE}"
echo "  卸载      sudo bash uninstall.sh"
echo "  打不开？云服务器记得在「安全组」放行 ${PORT} 端口"
echo