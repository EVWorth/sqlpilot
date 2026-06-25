#!/bin/bash
# Dev launcher — compiles and opens the Tauri app.

export PATH="/home/linuxbrew/.linuxbrew/bin:/home/elliot/.cargo/bin:/usr/bin:/bin"

cd "$(dirname "$0")/.." || exit 1

export GDK_BACKEND=wayland
export WEBKIT_DISABLE_COMPOSITING_MODE=1

# Kill any stale vite from previous runs
kill $(lsof -t -i :1420) 2>/dev/null
sleep 1

# Launch in background
npx tauri dev > /tmp/sqlpilot-build.log 2>&1 &
tauri_pid=$!

# Show progress dialog while waiting for the window to appear
zenity --progress --pulsate --no-cancel \
  --title="SQLPilot Dev" \
  --text="Compiling and launching...\n(This closes automatically)" \
  --width=400 &
zenity_pid=$!

# Wait for WebKit process (the app window) or until the build fails
while kill -0 $tauri_pid 2>/dev/null; do
  if pgrep -f "WebKit\|webkit2gtk" > /dev/null 2>&1; then
    sleep 2
    kill $zenity_pid 2>/dev/null
    break
  fi
  # Check if the build failed (exit without webkit)
  if ! kill -0 $tauri_pid 2>/dev/null; then
    kill $zenity_pid 2>/dev/null
    zenity --error --text="Build failed. Check /tmp/sqlpilot-build.log for details."
    break
  fi
  sleep 1
done

# Wait for app to close before exiting
wait $tauri_pid 2>/dev/null
