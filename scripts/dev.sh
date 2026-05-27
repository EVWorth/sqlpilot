#!/bin/bash
cd /var/home/elliot/repos/sqlpilot
export GDK_BACKEND=wayland
export WEBKIT_DISABLE_COMPOSITING_MODE=1
exec npx tauri dev
