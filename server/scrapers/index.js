const { scrapeFc2Content, searchFc2, parseFc2Url, normalizeFc2Result } = require('./fc2');
const { scrapeJavpopContent, searchJavpop, parseJavpopUrl, normalizeJavpopResult } = require('./javpop');
const { getBrowser, closeBrowser, withPage, getCloudflareCookies } = require('./browser');

module.exports = {
    // FC2
    scrapeFc2Content,
    searchFc2,
    parseFc2Url,
    normalizeFc2Result,

    // JAVPop
    scrapeJavpopContent,
    searchJavpop,
    parseJavpopUrl,
    normalizeJavpopResult,

    // Browser utilities
    getBrowser,
    closeBrowser,
    withPage,
    getCloudflareCookies,
};
