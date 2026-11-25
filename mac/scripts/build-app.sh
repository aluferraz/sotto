#!/bin/sh
# Builds dist/Sotto.app from the Swift package.
set -eu
cd "$(dirname "$0")/.."

swift build -c release
bin=$(swift build -c release --show-bin-path)

app=dist/Sotto.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin/Sotto" "$app/Contents/MacOS/Sotto"
cp Resources/Info.plist "$app/Contents/Info.plist"
cp engine/server.py "$app/Contents/Resources/server.py"

iconset=$(mktemp -d)/AppIcon.iconset
swift scripts/make-icon.swift "$iconset"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

# macOS ties the Microphone and Accessibility grants to the signature. Sign with, in order:
#   1. SOTTO_SIGN_IDENTITY, an identity in your own keychains;
#   2. the local certificate made by scripts/make-signing-identity.sh, which stays the same
#      from build to build, so the grants survive a rebuild;
#   3. an ad hoc signature, which changes with every build: the switch in System Settings
#      still looks on afterwards, but the app is refused until the grant is given again.
support="$HOME/Library/Application Support/Sotto"
if [ -n "${SOTTO_SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$SOTTO_SIGN_IDENTITY" --identifier dev.sotto.Sotto "$app"
elif [ -f "$support/signing.keychain-db" ] && [ -f "$support/signing.password" ] &&
    security unlock-keychain -p "$(cat "$support/signing.password")" "$support/signing.keychain-db" &&
    codesign --force --sign "Sotto Local Signing" --keychain "$support/signing.keychain-db" \
        --identifier dev.sotto.Sotto "$app"; then
    :
else
    echo "Signing ad hoc: permissions will have to be given again after this build."
    codesign --force --sign - --identifier dev.sotto.Sotto "$app"
fi
codesign --verify --strict "$app"
echo "Built $app"

# `build-app.sh --install` also replaces /Applications/Sotto.app and starts it.
if [ "${1:-}" = "--install" ]; then
    osascript -e 'tell application id "dev.sotto.Sotto" to quit' >/dev/null 2>&1 || true
    i=0
    while pgrep -x Sotto >/dev/null && [ $i -lt 20 ]; do sleep 0.25; i=$((i + 1)); done
    pkill -x Sotto 2>/dev/null || true
    # Grants made for a different signature no longer match; clear them so they can be given again.
    requirement() { codesign -d -r - "$1" 2>/dev/null | grep designated || true; }
    if [ "$(requirement "$app")" != "$(requirement /Applications/Sotto.app)" ]; then
        tccutil reset Accessibility dev.sotto.Sotto >/dev/null || true
        tccutil reset Microphone dev.sotto.Sotto >/dev/null || true
        echo "The signature changed: allow Microphone and Accessibility again in Sotto's Setup tab."
    fi
    rm -rf /Applications/Sotto.app
    ditto "$app" /Applications/Sotto.app
    open /Applications/Sotto.app
    echo "Installed /Applications/Sotto.app"
fi
