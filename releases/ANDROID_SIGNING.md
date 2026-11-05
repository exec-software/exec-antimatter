# Android production signing

Production Android updates must retain the application's signing identity and increase
`versionCode`. The repository contains only the public certificate and its expected
fingerprint:

- `android-release-certificate.pem`
- `android-signing.json`

Keep the private keystore and password outside the repository and release artifacts, with
restricted permissions and protected backups. Contributors can build with a local debug
identity; they do not need or receive the production key. A fork must use its own identity
and cannot replace an existing official installation in place.

The current production certificate's SHA-256 fingerprint is public verification metadata:

```text
9baaee2129b1bd0f21d6ef7559f825aaededaccd0f2c32ad0a5b3ce9a14b869a
```

## Sign a verified release input

First assemble and verify the release from the reviewed commit. Retain its exact unsigned
APK and provenance receipt. Use the pinned Android SDK Build Tools version recorded by the
project and a compatible Java runtime; no specific signing host or maintainer account is
required.

Align a copy of the unsigned APK before signing:

```bash
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
"$ANDROID_HOME/build-tools/36.1.0/zipalign" -P 16 -f 4 \
  app-release-unsigned.apk app-release-aligned.apk
```

On the protected signing environment, set `ANTIMATTER_ANDROID_KEYSTORE` and
`ANTIMATTER_ANDROID_PASSWORD_FILE` to the private files. They must not be copied into the
checkout. Passwords are read from the protected file rather than command arguments or logs.
The official PKCS12 identity uses the same password for the keystore and private key, so
omitting `--key-pass` reuses the keystore password.

```bash
set -eu
umask 077
: "${ANDROID_HOME:?Set ANDROID_HOME to your Android SDK}"
: "${ANTIMATTER_ANDROID_KEYSTORE:?Set the protected keystore path}"
: "${ANTIMATTER_ANDROID_PASSWORD_FILE:?Set the protected password-file path}"
test ! -e app-release-signed.apk
"$ANDROID_HOME/build-tools/36.1.0/apksigner" sign \
  --ks "$ANTIMATTER_ANDROID_KEYSTORE" \
  --ks-key-alias antimatter \
  --ks-pass "file:$ANTIMATTER_ANDROID_PASSWORD_FILE" \
  --v4-signing-enabled false \
  --debuggable-apk-permitted false \
  --out app-release-signed.apk app-release-aligned.apk
"$ANDROID_HOME/build-tools/36.1.0/apksigner" verify \
  --verbose --print-certs app-release-signed.apk
```

Return only the signed APK to the release environment. Import it with
`node scripts/import-android-release.mjs --apk /absolute/path/app-release-signed.apk`.
The importer verifies the pinned public certificate, package identity, version,
non-debuggable flag, signature schemes, and unchanged APK payload against the retained
unsigned input. Signing is not permission to substitute a later development build.

A debug-signed installation cannot be upgraded in place with the production APK. Preserve
user data and pairing until a deliberate migration is arranged. Do not regenerate the
official production identity to solve a local installation problem.
