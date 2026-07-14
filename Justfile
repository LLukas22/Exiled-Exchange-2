set positional-arguments := true

install:
    npm ci --prefix renderer
    npm ci --prefix main

make-index-files: install
    npm run make-index-files --prefix renderer

build-renderer: make-index-files
    npm run build --prefix renderer

build-main: install
    npm run build --prefix main

build: build-renderer build-main

package: build
    npm run package --prefix main

install-appimage:
    #!/usr/bin/env bash
    set -euo pipefail

    src="main/dist/Exiled Exchange 2-0.15.8.AppImage"
    dest="$HOME/Applications/Exiled-Exchange-2-0.15.8.AppImage"
    desktop="$HOME/.local/share/applications/exiled-exchange-2.desktop"
    launcher="$HOME/.local/bin/exiled-exchange-2"

    mkdir -p "$HOME/Applications"
    install -m 755 "$src" "$dest"
    mkdir -p "$HOME/.local/share/applications"
    desktop-file-install \
        --dir="$HOME/.local/share/applications" \
        --set-key=Exec \
        --set-value="$dest" \
        main/build/exiled-exchange-2.desktop
    chmod 644 "$desktop"
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    mkdir -p "$HOME/.local/bin"
    cat > "$launcher" <<'EOF'
    #!/usr/bin/env bash
    set -euo pipefail

    app="$HOME/Applications/Exiled-Exchange-2-0.15.8.AppImage"
    desktop_file="$HOME/.local/share/applications/exiled-exchange-2.desktop"

    export GIO_LAUNCHED_DESKTOP_FILE="$desktop_file"
    export GIO_LAUNCHED_DESKTOP_FILE_PID="$$"
    export CHROME_DESKTOP="exiled-exchange-2.desktop"
    export DESKTOP_STARTUP_ID="exiled-exchange-2"
    export XDG_CURRENT_DESKTOP="${XDG_CURRENT_DESKTOP:-KDE}"

    exec -a exiled-exchange-2 "$app" --class=exiled-exchange-2 "$@"
    EOF
    chmod 755 "$launcher"

    echo "Installed $dest"
    echo "Installed $desktop"
    echo "Installed $launcher"

all: clean install make-index-files build
    npm run package --prefix main

clean:
    rm -rf renderer/dist main/dist

check-types:
    npm run check-types --prefix renderer
    npm run check-types --prefix main

lint:
    npm run lint --prefix renderer || true
    npm run lint --prefix main || true

format:
    npm run format --prefix renderer
    npm run format --prefix main

dev setup:
    #!/usr/bin/env bash
    set -euo pipefail

    # Install deps + generate index files first
    npm ci --prefix renderer
    npm ci --prefix main
    npm run make-index-files --prefix renderer

    SESSION="ee2-dev"

    if tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "Session $SESSION already exists — attaching."
        tmux attach-session -t "$SESSION"
        exit 0
    fi

    tmux new-session -d -s "$SESSION" -n dev
    tmux send-keys -t "$SESSION" "cd renderer && npm run dev" Enter
    tmux split-window -h -t "$SESSION"
    tmux send-keys -t "$SESSION" "cd main && npm run dev" Enter
    tmux select-layout -t "$SESSION" even-horizontal
    tmux attach-session -t "$SESSION"
