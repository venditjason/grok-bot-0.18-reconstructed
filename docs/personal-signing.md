# Personal signing and safeStorage continuity

Electron documents that ad-hoc builds can be seen as different apps by macOS Keychain after updates: [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing). VenditBot 0.4.1 used a per-build cdhash requirement. Production builds now require a stable certificate-bound identity; personal signing is not Apple notarization.

Provisioning is a separate, explicitly approved operation. These scripts do not create, import, export, unlock or trust a certificate, change Keychain settings, or edit existing item access. Configure the **public** pins of the already provisioned valid code-signing identity:

```sh
export VENDITBOT_CODESIGN_IDENTITY='<40-hex certificate SHA-1>'
export VENDITBOT_CODESIGN_CERT_SHA256='<64-hex certificate SHA-256>'
```

The packager selects exactly that identity, uses each component's own identifier and embeds `identifier "…" and certificate leaf = H"…"` as the designated requirement. It checks the cryptographic requirement, exact embedded requirement and both public certificate hashes. It signs only copies inside its private staging directory. Certificate extraction reads the public certificate embedded in the app, never a Keychain private key.

After normal build/test validation, the first approved ad-hoc-to-certificate transition uses:

```sh
node scripts/package-venditbot.mjs --initial-certificate-release --output-dir /absolute/new/release-directory
```

Subsequent releases require the previous certificate-signed bundle:

```sh
node scripts/package-venditbot.mjs --previous-app /absolute/previous/VenditBot.app --output-dir /absolute/new/release-directory
```

The second command rejects a changed certificate or designated requirement. Missing pins, an unavailable identity or any signing failure stops production packaging. `--development` explicitly permits ad-hoc signing under the separate development app identity; it is not a production fallback.

## Native synthetic continuity check

Run only after identity provisioning and explicit authorization for a disposable Keychain canary. The driver creates a unique `VenditBotSigningQA-<uuid>` namespace. All main app/package names agree before the first `safeStorage` call. The inspected Electron 42.11.12 downstream non-MAS patch uses `<name> Key` as account and `<name> Safe Storage` as service, with the unsuffixed `<name>` account used only as a legacy fallback. Metadata-only `security find-generic-password` queries contain both exact selectors and no `-w` or `-g`. Both exact suffixed and legacy pairs must be absent before native launch; either existing pair causes an abort. The only deletion is the new suffixed pair proven absent before this driver's launch and observed afterward, recorded in a private journal; ambiguous cleanup fails visibly.

```sh
node scripts/qa-native-safestorage-continuity.mjs \
  --run-approved-native-safestorage \
  --runtime /absolute/pinned/Electron.app \
  --output-dir /private/tmp/vendit-new-private-canary-directory
```

The two native app builds have different versions and resources but the same certificate and designated requirement. The first encrypts synthetic data, its bundle is replaced at the same test path, and the second decrypts the unchanged encrypted file. The report separates signing, actual encryption/decryption and cleanup results. This is a certificate continuity test, not proof that an existing production Keychain item has already granted the new signing identity. Initial macOS approval for existing data remains a user action; never reset stored credentials to avoid it.

The driver does not run as part of unit tests or packaging. Until its actual native report passes, mark continuity as pending. Keep existing production data preservation/update/rollback checks as separate release gates.
