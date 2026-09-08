#!/usr/bin/env bash
# dsh-im-channel Linux 服务安装（systemd 用户服务，免 sudo）
# 用法: bash scripts/install-linux.sh   （在包目录或源码目录执行）
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${LARK_NODE_BIN:-$(command -v node)}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="dsh-im-channel.service"

# 1. lark-session 插件到 headless profile（与 macOS 流程一致）
mkdir -p "$(dirname "${DSH_HOME_DIR}/profiles/headless/node_modules/dsh-lark-session")"
rm -rf "${DSH_HOME_DIR}/profiles/headless/node_modules/dsh-lark-session"
cp -R "$BRIDGE_DIR/dsh-lark-session" "${DSH_HOME_DIR}/profiles/headless/node_modules/dsh-lark-session"
sed -i "s|__BRIDGE_DIR__|$BRIDGE_DIR|g" "${DSH_HOME_DIR}/profiles/headless/node_modules/dsh-lark-session/cordis.patch.yml" 2>/dev/null || true

# 2. systemd 用户服务（模板占位符替换）
mkdir -p "$UNIT_DIR"
sed -e "s|__BRIDGE_DIR__|$BRIDGE_DIR|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__DSH_HOME__|$DSH_HOME_DIR|g" \
    scripts/dsh-im-channel.service > "$UNIT_DIR/$UNIT_NAME"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"
systemctl --user status "$UNIT_NAME" --no-pager || true
