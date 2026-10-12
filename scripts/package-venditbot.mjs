import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions } from "@electron/asar";
import { PRODUCT_IDENTITY } from "../source/shared/product-identity.ts";
import { applyMacProductIdentity, verifyMacProductIdentity } from "./lib/macos-product-identity.mjs";
import {signingConfiguration,requireSigningIdentity,signingContinuityBaseline,signVenditBundle,verifyVenditBundleSigning,assertSigningContinuity} from './lib/venditbot-signing.mjs';
import { capture, run } from "./lib/process.mjs";
import { claimReleaseOutput } from './lib/venditbot-release-output.mjs';
import {validateRendererAssets} from './lib/venditbot-renderer-assets.mjs';

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("VenditBot packaging requires native macOS arm64. Other targets have not been validated.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const development = process.argv.includes("--development");
const signing=signingConfiguration({development});
await requireSigningIdentity(signing);
const previousAppArg=process.argv.indexOf('--previous-app');
if(previousAppArg!==-1&&(!process.argv[previousAppArg+1]||process.argv[previousAppArg+1].startsWith('--')))throw new Error('--previous-app requires the previous certificate-signed application path.');
const initialCertificateRelease=process.argv.includes('--initial-certificate-release');
const previousSigning=await signingContinuityBaseline({config:signing,previousApp:previousAppArg===-1?undefined:process.argv[previousAppArg+1],initialCertificateRelease,identifier:PRODUCT_IDENTITY.bundleId});
const staged = path.join(root, ".build", "venditbot-app");
const rendererSnapshot=await validateRendererAssets(path.join(staged,'renderer'));
const runtime = path.join(root, "node_modules", "electron", "dist", "Electron.app");
const version = JSON.parse(await readFile(path.join(staged, "package.json"), "utf8")).version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid staged version.");
const outputArg = process.argv.indexOf("--output-dir");
if (outputArg !== -1 && (!process.argv[outputArg + 1] || process.argv[outputArg + 1].startsWith("--"))) throw new Error("--output-dir requires a directory.");
// A release build must never replace the bundle from which the user is working.
const outputDirectory = outputArg === -1 ? path.join(root, "dist", ...(development ? [] : ["releases", version])) : path.resolve(process.argv[outputArg + 1]);
const output = path.join(outputDirectory, development ? "벤디트봇 개발.app" : PRODUCT_IDENTITY.bundleName);
const archiveOutput = path.join(outputDirectory, development ? "VenditBot-Development-macos-arm64.zip" : "VenditBot-macos-arm64.zip");
if (!development && (existsSync(output) || existsSync(archiveOutput))) throw new Error("Release output already exists. Choose a new --output-dir; existing production bundles are never overwritten.");
async function assertOutputNotRunning() {
  if (!existsSync(output)) return;
  const commands = await capture("/bin/ps", ["-ww", "-axo", "comm="]);
  if (commands.split("\n").some(command => command.normalize('NFC').includes(path.join(output, "Contents").normalize('NFC')))) throw new Error("The development app is running. Quit that test app before rebuilding it; production must stay open.");
}
await assertOutputNotRunning();
// File Provider can reattach FinderInfo to bundles under synced Documents while
// codesign is walking them. Seal outside that tree, then copy the finished app.
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "venditbot-package-"));
const temporary = path.join(temporaryRoot, development ? "벤디트봇 개발.app" : PRODUCT_IDENTITY.bundleName);
const archiveStage = path.join(temporaryRoot, "asar-stage");
await Promise.all([stat(path.join(staged, "main.cjs")), stat(path.join(staged, "preload.cjs")), stat(path.join(staged, "updater-helper.cjs")), stat(path.join(staged, "renderer", "index.html")), stat(path.join(staged, "runtimes", "codex", "bin", "codex")), stat(path.join(staged, "runtimes", "claude", "claude")), stat(path.join(runtime, "Contents", "Info.plist"))]);
await rm(temporary, { recursive: true, force: true });
await rm(archiveStage, { recursive: true, force: true });
await mkdir(archiveStage, { recursive: true });
await run("/usr/bin/ditto", [runtime, temporary]);
await run("/usr/bin/xattr", ["-cr", temporary]);
const resources = path.join(temporary, "Contents", "Resources");
await cp(path.join(root, 'resources', 'venditbot.icns'), path.join(resources, 'venditbot.icns'));
await rm(path.join(resources, "default_app.asar"), { force: true });
for (const entry of await readdir(staged)) {
  if (entry === "runtimes" || entry === "updater-helper.cjs") await cp(path.join(staged, entry), path.join(resources, entry), { recursive: true, dereference: false, verbatimSymlinks: true });
  else await cp(path.join(staged, entry), path.join(archiveStage, entry), { recursive: true, dereference: false, verbatimSymlinks: true });
}
const licenseDirectory = path.join(resources, "third-party-licenses");
await mkdir(licenseDirectory, { recursive: true });
for (const [source, destination] of [
  ["node_modules/electron/dist/LICENSE", "electron-LICENSE"],
  ["node_modules/electron/dist/LICENSES.chromium.html", "chromium-LICENSES.html"],
  ["node_modules/react/LICENSE", "react-LICENSE"],
  ["node_modules/react-dom/LICENSE", "react-dom-LICENSE"],
  ["node_modules/scheduler/LICENSE", "scheduler-LICENSE"],
  ["node_modules/@anthropic-ai/claude-code-darwin-arm64/LICENSE.md", "claude-code-LICENSE.md"],
  ["resources/licenses/openai-codex-0.162.1-LICENSE", "openai-codex-LICENSE"],
  ["resources/licenses/openai-codex-0.162.1-NOTICE", "openai-codex-NOTICE"],
  ["resources/licenses/provenance.json", "codex-license-provenance.json"],
  ["resources/licenses/lodash-4.18.0-LICENSE", "lodash-LICENSE"],
  ["resources/licenses/vds-lodash-provenance.json", "vds-lodash-provenance.json"],
  ["resources/licenses/vds-lodash-README.txt", "vds-lodash-README.txt"],
  ["resources/licenses/react-18.3.1-LICENSE", "react-18.3.1-LICENSE"],
  ["resources/licenses/react-18.3.1-provenance.json", "react-18.3.1-provenance.json"],
  ["NOTICE.md", "reconstruction-NOTICE.md"],
]) await cp(path.join(root, source), path.join(licenseDirectory, destination));
const codexPackage = JSON.parse(await readFile(path.join(root, "node_modules", "@openai", "codex", "package.json"), "utf8"));
if (codexPackage.version !== "0.162.1") throw new Error("Update the pinned Codex license provenance before packaging a different runtime version.");
const stagedPackage = JSON.parse(await readFile(path.join(archiveStage, "package.json"), "utf8"));
if (typeof stagedPackage.version !== "string" || !/^\d+\.\d+\.\d+$/.test(stagedPackage.version)) throw new Error("A numeric three-part VenditBot application version is required.");
await writeFile(path.join(archiveStage, "package.json"), `${JSON.stringify({ ...stagedPackage, name: "venditbot", productName: PRODUCT_IDENTITY.displayName, venditbotDevelopment: development }, null, 2)}\n`);
await validateRendererAssets(path.join(archiveStage,'renderer'),rendererSnapshot);
await createPackageWithOptions(archiveStage, path.join(resources, "app.asar"), { unpack: "**/*.node" });
await applyMacProductIdentity(temporary, { development });
await run('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'venditbot.icns', path.join(temporary, 'Contents', 'Info.plist')]);
for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) await run("/usr/bin/plutil", ["-replace", key, "-string", stagedPackage.version, path.join(temporary, "Contents", "Info.plist")]);
// Node's recursive copy can carry vendor quarantine/provenance/Finder xattrs
// in with the CLI payloads, after the initial Electron-template cleanup.
await run("/usr/bin/xattr", ["-cr", temporary]);

// Finder can restore bundle-directory metadata while the native payload is
// being signed. Clear the copied tree once more immediately before sealing it.
await run("/usr/bin/xattr", ["-cr", temporary]);
// Sign every copied Mach-O, nested framework/helper and root with the one pinned identity.
const signingVerification=await signVenditBundle(temporary,signing);
if(previousSigning)assertSigningContinuity(previousSigning,signingVerification);
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", temporary]);
const identity = await verifyMacProductIdentity(temporary, { development });
await mkdir(path.dirname(output), { recursive: true });
const temporaryArchive = path.join(temporaryRoot, 'verified-release.zip');
await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", "--noextattr", temporary, temporaryArchive]);
const archiveCheck = path.join(temporaryRoot, "archive-check");
await mkdir(archiveCheck);
await run("/usr/bin/ditto", ["-x", "-k", temporaryArchive, archiveCheck]);
const extractedApp = path.join(archiveCheck, path.basename(temporary));
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", extractedApp]);
await verifyMacProductIdentity(extractedApp, {development});
const extractedSigning=await verifyVenditBundleSigning(extractedApp,signing);
if(!development)assertSigningContinuity(signingVerification,extractedSigning);
if (development) {
  // Recheck after slow signing/archive validation: a test app may have opened.
  await assertOutputNotRunning();
  await rm(output, {recursive: true, force: true});
  await copyFile(temporaryArchive, archiveOutput);
} else {
  // Exclusive creation closes the preflight/signing TOCTOU window. Never remove
  // or overwrite a production bundle or a release ZIP, even in concurrent builds.
  await claimReleaseOutput(temporaryArchive, output, archiveOutput);
}
// ditto preserves the relative Versions/Current links required by sealed
// frameworks. fs.cp defaults can turn these into references to the build tree.
await run("/usr/bin/ditto", [temporary, output]);
await run("/usr/bin/xattr", ["-cr", output]);
let copiedAppSignatureVerified = true;
let copiedAppWarning;
try { await capture("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]); }
catch (error) {
  if (!String(error).includes("resource fork, Finder information, or similar detritus")) throw error;
  copiedAppSignatureVerified = false;
  copiedAppWarning = "File Provider reattached Finder metadata to the app copy. The ZIP was extracted and strictly signature-verified in a separate temporary directory. Extract it outside a synced Documents folder for installation.";
  console.warn(copiedAppWarning);
}
const archiveSha256 = createHash("sha256").update(await readFile(archiveOutput)).digest("hex");
await writeFile(path.join(outputDirectory, development ? "venditbot-development-package-verification.json" : "venditbot-package-verification.json"), `${JSON.stringify({ ...identity, version, appPath: output, archivePath: archiveOutput, archiveSha256, archiveSignatureVerified: true, copiedAppSignatureVerified, ...(copiedAppWarning ? {copiedAppWarning} : {}), ...extractedSigning, signingContinuity: development?'development-only':previousSigning?'verified-with-previous-app':'explicit-initial-certificate-transition', notarized: false, nativeDockerArm64Verified: false, packagedAt: new Date().toISOString() }, null, 2)}\n`, {flag: development ? "w" : "wx"});
console.log(`Packaged ${identity.displayName}: ${output} (arm64; ${identity.helperCount} renamed helpers; ${extractedSigning.signature}, not notarized)`);
await rm(temporaryRoot, {recursive: true, force: true});
