/**
 * electron-builder afterPack hook (pattern from craft-agents-oss).
 *
 * If you add a pre-built macOS 26+ `Assets.car` under `apps/electron/build/`,
 * it is copied into the app bundle. Otherwise this is a no-op.
 *
 * Regenerate (optional, requires Xcode 26+ SDK):
 *   cd apps/electron && xcrun actool "build/icon.iconset" --compile "build" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 */

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    console.log('[afterPack] skip (not darwin)');
    return;
  }

  const appOutDir = context.appOutDir;
  let appName;
  try {
    appName = fs.readdirSync(appOutDir).find((f) => f.endsWith('.app'));
  } catch (e) {
    console.warn('[afterPack] could not read appOutDir:', appOutDir, e);
    return;
  }
  if (!appName) {
    console.warn('[afterPack] no .app bundle in', appOutDir);
    return;
  }

  const resourcesDir = path.join(appOutDir, appName, 'Contents', 'Resources');
  const precompiled = path.join(context.packager.projectDir, 'build', 'Assets.car');

  if (!fs.existsSync(precompiled)) {
    console.log('[afterPack] no build/Assets.car — using electron-builder default icon only');
    return;
  }

  try {
    fs.copyFileSync(precompiled, path.join(resourcesDir, 'Assets.car'));
    console.log('[afterPack] copied Assets.car →', resourcesDir);
  } catch (err) {
    console.warn('[afterPack] Assets.car copy failed:', err?.message || err);
  }
};
