#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build/checks
CHECK_SDK=$(xcrun --sdk macosx --show-sdk-path)
swiftc -swift-version 6 -target "$(uname -m)-apple-macosx14.0" -sdk "$CHECK_SDK" \
  -module-cache-path .build/checks/modules -D STANDALONE_CONTRACT_CHECK \
  Sources/CompanionCore/*.swift Tests/CompanionCoreTests/*.swift scripts/ContractCheckRunner.swift \
  -o .build/checks/contract-checks
.build/checks/contract-checks
plutil -lint VenditBotCompanion.xcodeproj/project.pbxproj
