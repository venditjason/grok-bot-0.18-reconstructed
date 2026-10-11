The supplied VDS 2.11.0 design-system bundle embedded Lodash 4.17.21.
VenditBot replaces only that CommonJS module with official Lodash 4.18.0,
which fixes GHSA-r5fr-rjxr-66jc and GHSA-f23m-r3pf-42rh. No design-system
component, token, style or other bundled dependency is rewritten.

The original VDS bundle, official package source, full MIT license, replaced
module, unchanged prefix/suffix, and resulting bundle are SHA256-pinned in
vds-lodash-provenance.json. The original bundled license notice is preserved,
and the replacement retains the official source license header verbatim.

To reproduce (from repository root, with the originally supplied VDS bundle):
  mkdir -p work/lodash-patch
  npm pack lodash@4.18.0 --ignore-scripts --registry=https://registry.npmjs.org --cache ./work/lodash-patch/npm-cache --pack-destination ./work/lodash-patch
  node scripts/patch-vds-lodash.mjs --original /path/to/original/_ds_bundle.js --tarball work/lodash-patch/lodash-4.18.0.tgz

Append --check to verify the checked-in bundle, license, and provenance
without writing. The script rejects unrecognized original bundle hashes,
package versions, source/license hashes, or npm tarball integrity values.
It uses Acorn AST offsets instead of text matching for module boundaries.
No package.json or package-lock.json modification is required.

Verification:
  node --test tests/venditbot-vds-vendor.test.mjs tests/venditbot-ui-render.test.mjs

VDS currently calls only Lodash isPlainObject and mapValues for color/token
transforms. Tests also cover the replaced security-sensitive functions so
unused vulnerable code is not retained in the shipped vendor bundle.
