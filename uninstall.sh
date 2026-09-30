#!/usr/bin/env bash
# 卸载服务。默认保留 config.json 与日志，加 --purge 一起删。
set -euo pipefail
PREFIX="${PREFIX:-/opt/serverpulse}"
SERVICE="${SERVICE:-serverpulse}"
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$PREFIX" "/var/log/${SERVICE}.log"
  echo "已彻底删除 $PREFIX 与日志"
else
  echo "已停用并删除服务；保留 $PREFIX/config.json 与 /var/log/${SERVICE}.log（清干净请加 --purge）"
fi
