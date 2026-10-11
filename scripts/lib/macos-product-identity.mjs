import { readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_IDENTITY } from "../../source/shared/product-identity.ts";
import { capture, run } from "./process.mjs";

const PLUTIL = "/usr/bin/plutil";
const readPlist = async file => JSON.parse(await capture(PLUTIL, ["-convert", "json", "-o", "-", file]));
const replace = async (file, key, value) => run(PLUTIL, ["-replace", key, "-string", value, file]);

export function planMacProductIdentity({ sourceName, helperNames, development = false }) {
  if (sourceName !== "Electron") throw new Error("Expected the dependency-pinned Electron runtime template.");
  const suffixes = ["", " (GPU)", " (Renderer)", " (Plugin)"];
  if (helperNames.length !== suffixes.length || suffixes.some(suffix => !helperNames.includes(`${sourceName} Helper${suffix}.app`))) throw new Error("Unexpected Electron helper ABI layout; inspect before renaming.");
  const executableName = development ? `${PRODUCT_IDENTITY.executableName} Development` : PRODUCT_IDENTITY.executableName;
  const bundleId = development ? PRODUCT_IDENTITY.developmentBundleId : PRODUCT_IDENTITY.bundleId;
  return {
    executableName, bundleId,
    displayName: development ? `${PRODUCT_IDENTITY.displayName} 개발` : PRODUCT_IDENTITY.displayName,
    helpers: suffixes.map(suffix => ({
      sourceBundleName: `${sourceName} Helper${suffix}.app`,
      sourceExecutableName: `${sourceName} Helper${suffix}`,
      bundleName: `${executableName} Helper${suffix}.app`,
      executableName: `${executableName} Helper${suffix}`,
      bundleId: `${bundleId}.helper${suffix ? `.${suffix.slice(2, -1).toLowerCase()}` : ""}`,
    })),
  };
}

async function assertArm64(executable) {
  const architectures = (await capture("/usr/bin/lipo", ["-archs", executable])).split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== "arm64") throw new Error(`Expected a native arm64 executable: ${executable}`);
}

function linkedMachOLibraries(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a thin 64-bit Mach-O helper.");
  const commandCount = bytes.readUInt32LE(16);
  const libraries = [];
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > bytes.length) throw new Error("Truncated Mach-O helper commands.");
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error("Invalid Mach-O helper command.");
    if (command === 0xc) {
      if (size < 24) throw new Error("Truncated Mach-O dylib command.");
      const nameOffset = bytes.readUInt32LE(offset + 8);
      const nameEnd = bytes.indexOf(0, offset + nameOffset);
      if (nameOffset < 24 || nameEnd < offset + nameOffset || nameEnd >= offset + size) throw new Error("Invalid Mach-O dylib name.");
      libraries.push(bytes.subarray(offset + nameOffset, nameEnd).toString("utf8"));
    }
    offset += size;
  }
  return libraries;
}

/** Rename the executable, CFBundleName and every helper as one coherent Electron contract.
 * Framework paths and all Mach-O bytes remain unchanged until ad-hoc signing.
 */
export async function applyMacProductIdentity(appPath, { development = false } = {}) {
  const contents = path.join(appPath, "Contents");
  const plist = path.join(contents, "Info.plist");
  const original = await readPlist(plist);
  const frameworks = path.join(contents, "Frameworks");
  const helperNames = (await readdir(frameworks)).filter(name => name.endsWith(".app"));
  const plan = planMacProductIdentity({ sourceName: original.CFBundleExecutable, helperNames, development });
  const mainExecutable = path.join(contents, "MacOS", original.CFBundleExecutable);
  await assertArm64(mainExecutable);
  for (const helper of plan.helpers) {
    const helperContents = path.join(frameworks, helper.sourceBundleName, "Contents");
    const info = await readPlist(path.join(helperContents, "Info.plist"));
    // Electron 42's template omits CFBundleExecutable and uses CFBundleName.
    // Accept only that inspected fallback or an exact explicit executable name.
    if ((info.CFBundleExecutable !== undefined && info.CFBundleExecutable !== helper.sourceExecutableName) || info.CFBundleName !== helper.sourceExecutableName) throw new Error(`Unexpected helper identity in ${helper.sourceBundleName}`);
    const executable = path.join(helperContents, "MacOS", helper.sourceExecutableName);
    await assertArm64(executable);
    // otool-classic interprets '(GPU)' in a filename as archive-member syntax.
    // Read the actual LC_LOAD_DYLIB commands so every helper role is verified.
    const libraries = linkedMachOLibraries(await readFile(executable));
    if (!libraries.some(library => library.endsWith("/Electron Framework.framework/Electron Framework"))) throw new Error(`Unrecognized Electron helper framework linkage: ${helper.sourceBundleName}`);
  }
  const originalMainBytes = await readFile(mainExecutable);
  await rename(mainExecutable, path.join(contents, "MacOS", plan.executableName));
  for (const [key, value] of Object.entries({ CFBundleIdentifier: plan.bundleId, CFBundleExecutable: plan.executableName, CFBundleName: plan.executableName, CFBundleDisplayName: plan.displayName })) await replace(plist, key, value);
  await run(PLUTIL, ["-replace", "CFBundleURLTypes", "-json", JSON.stringify(development ? [] : [{ CFBundleTypeRole: "Viewer", CFBundleURLName: plan.bundleId, CFBundleURLSchemes: [PRODUCT_IDENTITY.scheme] }]), plist]);
  // Template integrity metadata cannot describe our new ASAR.
  if (original.ElectronAsarIntegrity !== undefined) await run(PLUTIL, ["-remove", "ElectronAsarIntegrity", plist]);
  for (const helper of plan.helpers) {
    const oldBundle = path.join(frameworks, helper.sourceBundleName);
    const helperContents = path.join(oldBundle, "Contents");
    const helperPlist = path.join(helperContents, "Info.plist");
    const oldExecutable = path.join(helperContents, "MacOS", helper.sourceExecutableName);
    const before = await readFile(oldExecutable);
    const newExecutable = path.join(helperContents, "MacOS", helper.executableName);
    await rename(oldExecutable, newExecutable);
    for (const [key, value] of Object.entries({ CFBundleIdentifier: helper.bundleId, CFBundleName: helper.executableName, CFBundleExecutable: helper.executableName, CFBundleDisplayName: helper.executableName })) await replace(helperPlist, key, value);
    if (!before.equals(await readFile(newExecutable))) throw new Error("Renaming changed helper executable bytes.");
    await rename(oldBundle, path.join(frameworks, helper.bundleName));
  }
  if (!originalMainBytes.equals(await readFile(path.join(contents, "MacOS", plan.executableName)))) throw new Error("Renaming changed main executable bytes.");
  return plan;
}

export async function verifyMacProductIdentity(appPath, { development = false } = {}) {
  const contents = path.join(appPath, "Contents");
  const info = await readPlist(path.join(contents, "Info.plist"));
  const plan = planMacProductIdentity({ sourceName: "Electron", helperNames: ["Electron Helper.app", "Electron Helper (GPU).app", "Electron Helper (Renderer).app", "Electron Helper (Plugin).app"], development });
  if (info.CFBundleIdentifier !== plan.bundleId || info.CFBundleExecutable !== plan.executableName || info.CFBundleName !== plan.executableName || info.CFBundleDisplayName !== plan.displayName) throw new Error("Packaged VenditBot bundle identity is inconsistent.");
  const schemes = (info.CFBundleURLTypes ?? []).flatMap(entry => entry.CFBundleURLSchemes ?? []);
  if (JSON.stringify(schemes) !== JSON.stringify(development ? [] : [PRODUCT_IDENTITY.scheme])) throw new Error("VenditBot must own only its dedicated URL scheme; development bundles own no shared scheme.");
  await assertArm64(path.join(contents, "MacOS", plan.executableName));
  const frameworkNames = (await readdir(path.join(contents, "Frameworks"))).filter(name => name.endsWith(".app")).sort();
  if (JSON.stringify(frameworkNames) !== JSON.stringify(plan.helpers.map(helper => helper.bundleName).sort())) throw new Error("Packaged Electron helper inventory differs from its bundle-name contract.");
  for (const helper of plan.helpers) {
    const helperContents = path.join(contents, "Frameworks", helper.bundleName, "Contents");
    const helperInfo = await readPlist(path.join(helperContents, "Info.plist"));
    if (helperInfo.CFBundleIdentifier !== helper.bundleId || helperInfo.CFBundleExecutable !== helper.executableName || helperInfo.CFBundleName !== helper.executableName) throw new Error(`Invalid packaged helper identity: ${helper.bundleName}`);
    await assertArm64(path.join(helperContents, "MacOS", helper.executableName));
  }
  return { architecture: "arm64", bundleId: plan.bundleId, displayName: plan.displayName, executableName: plan.executableName, helperCount: plan.helpers.length, schemes };
}
