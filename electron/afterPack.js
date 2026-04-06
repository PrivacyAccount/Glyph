const path = require('path');
const fs = require('fs');
const { rcedit } = require('rcedit');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;

    const appOutDir = context.appOutDir;
    const productFilename = context.packager?.appInfo?.productFilename;
    if (!appOutDir || !productFilename) return;

    const exePath = path.join(appOutDir, `${productFilename}.exe`);
    if (!fs.existsSync(exePath)) return;

    const iconPath = path.resolve(context.packager.projectDir, 'src', 'assets', 'icons', 'glyph.ico');
    if (!fs.existsSync(iconPath)) {
        // Keep pack process resilient if icon path is missing.
        return;
    }

    await rcedit(exePath, { icon: iconPath });
    console.log(`[afterPack] Stamped EXE icon: ${exePath}`);
};
