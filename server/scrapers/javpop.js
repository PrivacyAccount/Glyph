const { withPage } = require('./browser');

const JAVPOP_BASE = 'https://javpop.com';

function parseJavpopUrl(url) {
    try {
        const urlObj = new URL(url);
        if (!urlObj.hostname.includes('javpop')) return null;

        // URL formats:
        // https://javpop.com/{post-slug}.html
        // https://javpop.com/archives/{id}
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 1) {
            const slug = pathParts[pathParts.length - 1].replace('.html', '');
            return { slug, postId: pathParts.length > 1 ? pathParts[1] : '' };
        }
        return null;
    } catch {
        return null;
    }
}

async function scrapeJavpopContent(urlOrId) {
    let url;
    const parsed = parseJavpopUrl(urlOrId);
    if (parsed) {
        url = urlOrId;
    } else {
        // Treat as post slug
        url = `${JAVPOP_BASE}/${urlOrId}.html`;
    }

    const result = await withPage(url, async (page) => {
        await page.waitForSelector('.post, .entry, article, .video_content', { timeout: 30000 })
            .catch(() => { });

        const metadata = await page.evaluate(() => {
            const getText = (selector) => {
                const el = document.querySelector(selector);
                return el ? el.textContent.trim() : '';
            };

            const getTexts = (selector) => {
                return Array.from(document.querySelectorAll(selector))
                    .map(el => el.textContent.trim())
                    .filter(Boolean);
            };

            const getImage = (selector) => {
                const el = document.querySelector(selector);
                return el ? (el.src || el.dataset.src || '') : '';
            };

            // Title
            let title = getText('.post-title, .entry-title, h1.title, article h1');
            if (!title) {
                title = getText('meta[property="og:title"]');
                if (!title) title = document.title.split('|')[0].trim();
            }

            // Description
            let description = getText('.entry-content, .post-content, .description, .synopsis');

            // JAV Code / ID - typically found in title or content
            let javId = '';
            const javIdMatch = title.match(/([A-Z]{2,6}-?\d{3,5})/i);
            if (javIdMatch) {
                javId = javIdMatch[1].toUpperCase();
            }

            // Thumbnail/Poster - look for cover image
            let thumbUrl = getImage('.post-thumbnail img, .entry-image img, .cover img, .post-image img');
            if (!thumbUrl) {
                const ogImage = document.querySelector('meta[property="og:image"]');
                thumbUrl = ogImage ? ogImage.content : '';
            }

            // Look for screenshots/gallery
            const screenshots = [];
            document.querySelectorAll('.screenshots img, .gallery img, .entry-content img').forEach(el => {
                const src = el.src || el.dataset.src || '';
                if (src && !src.includes('avatar') && !src.includes('logo')) {
                    screenshots.push(src);
                }
            });

            // Release date
            let releaseDate = getText('.post-date, .release-date, .date, time');
            if (!releaseDate) {
                const dateMeta = document.querySelector('meta[property="article:published_time"]');
                releaseDate = dateMeta ? dateMeta.content.split('T')[0] : '';
            }

            // Duration
            let duration = getText('.duration, .length');

            // Studio/Label
            let siteName = '';
            const studioMatch = document.body.innerText.match(/(?:Studio|Maker|Label):\s*([^\n]+)/i);
            if (studioMatch) siteName = studioMatch[1].trim();

            // Performers/Actresses
            const performers = [];
            const actressMatch = document.body.innerText.match(/(?:Actress|Performer|Cast):\s*([^\n]+)/i);
            if (actressMatch) {
                const names = actressMatch[1].split(/[,、,]/).map(n => n.trim()).filter(Boolean);
                performers.push(...names);
            }

            // Tags/Categories/Genres
            const tags = [];
            document.querySelectorAll('.tags a, .categories a, .genre a, a[rel="tag"]').forEach(el => {
                const tag = el.textContent.trim();
                if (tag && tag.length < 30) tags.push(tag);
            });

            // Post slug from URL
            const slug = (() => {
                const path = window.location.pathname.replace(/^\//, '').replace(/\.html$/, '');
                return path;
            })();

            return {
                title,
                description,
                javId,
                thumbUrl,
                screenshots,
                releaseDate,
                duration,
                siteName,
                tags,
                performers,
                slug,
                sourceUrl: window.location.href,
            };
        });

        return metadata;
    }, {
        delay: 2000,
        waitForSelector: '.post, .entry, article',
    });

    return result;
}

async function searchJavpop(query) {
    const searchUrl = `${JAVPOP_BASE}/search/${encodeURIComponent(query)}`;

    const results = await withPage(searchUrl, async (page) => {
        await page.waitForSelector('.post, .search-result, .entry, article', { timeout: 30000 })
            .catch(() => { });

        const items = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('.post, .entry, article, .search-item').forEach(el => {
                const titleEl = el.querySelector('.post-title, .entry-title, h2, h3');
                const linkEl = el.querySelector('a[href*=".html"]');
                const thumbEl = el.querySelector('img');
                const dateEl = el.querySelector('.post-date, .date, time');

                if (titleEl && linkEl) {
                    results.push({
                        title: titleEl.textContent.trim(),
                        url: linkEl.href,
                        thumbUrl: thumbEl ? (thumbEl.src || thumbEl.dataset.src || '') : '',
                        date: dateEl ? dateEl.textContent.trim() : '',
                    });
                }
            });
            return results;
        });

        return items;
    }, {
        delay: 2000,
    });

    return results;
}

function normalizeJavpopResult(raw) {
    return {
        id: raw.javId || raw.slug || '',
        title: raw.title || '',
        description: raw.description || '',
        date: raw.releaseDate || '',
        thumbUrl: raw.thumbUrl || '',
        posterUrl: raw.thumbUrl || '',
        siteName: raw.siteName || 'JAVPop',
        sourceUrl: raw.sourceUrl || '',
        performers: Array.isArray(raw.performers) ? raw.performers.map(p => typeof p === 'string' ? { name: p } : p) : [],
        tags: raw.tags || [],
        screenshots: raw.screenshots || [],
        itemType: 'jav',
        provider: 'javpop',
        raw,
    };
}

module.exports = {
    scrapeJavpopContent,
    searchJavpop,
    parseJavpopUrl,
    normalizeJavpopResult,
};
