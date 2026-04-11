const path = require('path');
const fs = require('fs');
const { rcedit } = require('rcedit');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName === 'linux') {
        try {
            const mpvPath = path.join(context.appOutDir, 'resources', 'vendor', 'mpv', 'mpv');
            if (fs.existsSync(mpvPath)) {
                fs.chmodSync(mpvPath, 0o755);
                console.log(`[afterPack] Ensured executable bit on Linux mpv: ${mpvPath}`);
            }
        } catch (err) {
            console.warn(`[afterPack] Failed to chmod Linux mpv: ${err?.message || err}`);
        }
        return;
    }
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
