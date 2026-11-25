#!/bin/sh
# Creates a self-signed code-signing certificate for local builds of Sotto.
#
# macOS ties the Microphone and Accessibility grants to the app's signature. An ad hoc
# signature is different for every build, so each rebuild loses both grants and leaves a
# switch in System Settings that looks on but no longer matches. Signing every build with
# the same certificate keeps the grants.
#
# The certificate and its key live in their own keychain file, not in the login keychain:
#   ~/Library/Application Support/Sotto/signing.keychain-db
# Its password is in signing.password next to it (readable by you only), so the build
# script can unlock it without asking.
#
# codesign only finds identities in keychains on the user's search list, so after running
# this once, add the file to the list (this keeps the login keychain first):
#   security list-keychains -d user -s ~/Library/Keychains/login.keychain-db \
#       "$HOME/Library/Application Support/Sotto/signing.keychain-db"
#
# To undo: set the search list back to the login keychain alone and delete both files.
set -eu

name="Sotto Local Signing"
dir="$HOME/Library/Application Support/Sotto"
keychain="$dir/signing.keychain-db"
passfile="$dir/signing.password"

if [ -f "$keychain" ] && [ -f "$passfile" ]; then
    echo "Signing identity already exists: $keychain"
    exit 0
fi

mkdir -p "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# The system LibreSSL writes a PKCS#12 file that `security import` reads.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$name" -passout pass:transfer \
    -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12"

password=$(/usr/bin/openssl rand -hex 24)
(umask 077; printf '%s' "$password" > "$passfile")

rm -f "$keychain"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings "$keychain"          # no auto-lock timeout
security unlock-keychain -p "$password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P transfer -T /usr/bin/codesign >/dev/null
# Let codesign use the key without a confirmation dialog.
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null

echo "Created \"$name\" in $keychain"
