#!/usr/bin/env bash
# 前台快速启动：没有 config.json 就生成一个（随机 token），然后直接跑。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { echo "需要先装 Node.js >= 18"; exit 1; }
MAJOR="$(node -p "process.versions.node.split(\".\")[0]")"
[ "$MAJOR" -ge 18 ] || { echo "Node 版本过低：$(node -v)，需要 >= 18"; exit 1; }
if [ ! -f config.json ]; then
  TOKEN="$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require(\"crypto\").randomBytes(16).toString(\"hex\"))")"
  node -e "require(\"fs\").writeFileSync(\"config.json\", JSON.stringify({port:Number(process.env.MONITOR_PORT||8080),host:\"0.0.0.0\",token:process.argv[1],sessionDays:5,intervalMs:2000,label:require(\"os\").hostname()},null,2)+\"\n\")" "$TOKEN"
  chmod 600 config.json
  echo "已生成 config.json，token: $TOKEN"
fi
PORT="$(node -p "try{JSON.parse(require(\"fs\").readFileSync(\"config.json\",\"utf8\")).port||8080}catch(e){8080}")"
TOKEN="$(node -p "try{JSON.parse(require(\"fs\").readFileSync(\"config.json\",\"utf8\")).token||\"\"}catch(e){\"\"}")"
IP="$(hostname -I 2>/dev/null | cut -d' ' -f1)"
[ -n "$IP" ] || IP="<服务器IP>"
echo "面板  http://${IP}:${PORT}/"
echo "口令  ${TOKEN}"
exec node monitor.mjs
