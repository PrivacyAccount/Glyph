const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserPromise = null;

async function getBrowser(options = {}) {
    if (browserInstance && browserInstance.isConnected()) {
        return browserInstance;
    }
    if (browserPromise) {
        return browserPromise;
    }
    browserPromise = puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        ignoreHTTPSErrors: true,
        ...options,
    }).then((browser) => {
        browserInstance = browser;
        browser.on('disconnected', () => {
            browserInstance = null;
            browserPromise = null;
        });
        return browser;
    });
    return browserPromise;
}

async function closeBrowser() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
        browserPromise = null;
    }
}

async function withPage(url, callback, options = {}) {
    const browser = await getBrowser(options.browserOptions);
    const page = await browser.newPage();

    const timeout = options.timeout || 60000;
    const waitForSelector = options.waitForSelector;
    const waitForNavigation = options.waitForNavigation !== false;

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        if (options.cookies && Array.isArray(options.cookies)) {
            await page.setCookie(...options.cookies);
        }

        await page.goto(url, {
            waitUntil: waitForNavigation ? 'networkidle2' : 'domcontentloaded',
            timeout,
        });

        // Check for Cloudflare challenge
        const cfChallenge = await page.$('iframe[src*="challenges.cloudflare.com"]') ||
            await page.$('.challenge-running') ||
            await page.$('#challenge-running');

        if (cfChallenge) {
            console.log('[browser] Cloudflare challenge detected, waiting for user interaction...');
            // Wait up to 2 minutes for challenge completion
            await page.waitForFunction(() => {
                return !document.querySelector('iframe[src*="challenges.cloudflare.com"]') &&
                    !document.querySelector('.challenge-running') &&
                    !document.querySelector('#challenge-running');
            }, { timeout: 120000 }).catch(() => {
                console.log('[browser] Cloudflare challenge timeout, proceeding anyway');
            });
        }

        if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout }).catch(() => { });
        }

        // Additional wait for dynamic content
        await new Promise(resolve => setTimeout(resolve, options.delay || 1000));

        const result = await callback(page);
        return result;
    } finally {
        await page.close().catch(() => { });
    }
}

async function getCloudflareCookies(url) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const cfChallenge = await page.$('iframe[src*="challenges.cloudflare.com"]') ||
            await page.$('.challenge-running');

        if (cfChallenge) {
            console.log('[browser] Cloudflare challenge detected, waiting...');
            await page.waitForFunction(() => {
                return !document.querySelector('iframe[src*="challenges.cloudflare.com"]') &&
                    !document.querySelector('.challenge-running');
            }, { timeout: 120000 }).catch(() => { });
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        const cookies = await page.cookies();
        return cookies;
    } finally {
        await page.close().catch(() => { });
    }
}

module.exports = {
    getBrowser,
    closeBrowser,
    withPage,
    getCloudflareCookies,
};
