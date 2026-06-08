const { withPage, getCloudflareCookies } = require('./browser');

const FC2_BASE = 'https://adult.fc2.com';

function parseFc2Url(url) {
    try {
        const urlObj = new URL(url);
        if (!urlObj.hostname.includes('fc2.com')) return null;

        // URL formats:
        // https://adult.fc2.com/content/{contentId}
        // https://adult.fc2.com/pages/article.php?aid={contentId}
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.includes('content') && pathParts.length >= 2) {
            const contentId = pathParts[pathParts.indexOf('content') + 1];
            return { contentId };
        }
        if (pathParts.includes('pages') && urlObj.searchParams.has('aid')) {
            return { contentId: urlObj.searchParams.get('aid') };
        }
        return null;
    } catch {
        return null;
    }
}

async function scrapeFc2Content(urlOrId) {
    let url;
    const parsed = parseFc2Url(urlOrId);
    if (parsed) {
        url = urlOrId;
    } else {
        // Treat as content ID
        const contentId = String(urlOrId).replace(/[^a-zA-Z0-9]/g, '');
        url = `${FC2_BASE}/content/${contentId}`;
    }

    const result = await withPage(url, async (page) => {
        // Wait for main content
        await page.waitForSelector('.contents_detail, .article_detail, .main_content', { timeout: 30000 })
            .catch(() => { });

        const metadata = await page.evaluate(() => {
            const getText = (selector) => {
                const el = document.querySelector(selector);
                return el ? el.textContent.trim() : '';
            };

            const getImage = (selector) => {
                const el = document.querySelector(selector);
                return el ? (el.src || el.dataset.src || '') : '';
            };

            // Title
            let title = getText('h1.title, .title_main, .content_title, .article_title');
            if (!title) {
                title = getText('meta[property="og:title"]');
                if (!title) title = document.title.split('|')[0].trim();
            }

            // Description
            let description = getText('.description, .content_description, .article_body, .sentence');
            if (!description) {
                const metaDesc = document.querySelector('meta[name="description"], meta[property="og:description"]');
                description = metaDesc ? metaDesc.content : '';
            }

            // Thumbnail/Poster
            let thumbUrl = getImage('.main_thumb img, .content_thumb img, .thumbnail img, .article_thumb img');
            if (!thumbUrl) {
                const ogImage = document.querySelector('meta[property="og:image"]');
                thumbUrl = ogImage ? ogImage.content : '';
            }

            // Release date
            let releaseDate = getText('.release_date, .date, .upload_date');
            if (!releaseDate) {
                const dateEl = document.querySelector('.info_item:has(.label:contains("公開日")) .value, .upload-date');
                releaseDate = dateEl ? dateEl.textContent.trim() : '';
            }

            // Duration
            let duration = getText('.duration, .length, .video_duration');

            // Seller/Studio
            let siteName = getText('.seller_name, .user_name, .author_name, .studio_name');

            // Tags/Categories
            const tags = [];
            document.querySelectorAll('.tag, .category, .tag_list a, .keyword a').forEach(el => {
                const tag = el.textContent.trim();
                if (tag && tag.length < 50) tags.push(tag);
            });

            // Performers (if available)
            const performers = [];
            document.querySelectorAll('.performer, .actress, .actor_name').forEach(el => {
                const name = el.textContent.trim();
                if (name) performers.push(name);
            });

            // Content ID from URL
            const contentId = (() => {
                const m = window.location.pathname.match(/\/content\/([^/]+)/);
                if (m) return m[1];
                const aid = new URLSearchParams(window.location.search).get('aid');
                return aid || '';
            })();

            return {
                title,
                description,
                thumbUrl,
                releaseDate,
                duration,
                siteName,
                tags,
                performers,
                contentId,
                sourceUrl: window.location.href,
            };
        });

        return metadata;
    }, {
        delay: 2000,
        waitForSelector: '.contents_detail, .article_detail',
    });

    return result;
}

async function searchFc2(query) {
    const searchUrl = `${FC2_BASE}/search/?keyword=${encodeURIComponent(query)}`;

    const results = await withPage(searchUrl, async (page) => {
        await page.waitForSelector('.search_result, .content_list, .list_item', { timeout: 30000 })
            .catch(() => { });

        const items = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('.content_list_item, .list_item, .search_item, .article_item').forEach(el => {
                const titleEl = el.querySelector('.title, .content_title, h3, h4');
                const linkEl = el.querySelector('a[href*="/content/"], a[href*="article.php"]');
                const thumbEl = el.querySelector('img');
                const dateEl = el.querySelector('.date, .release_date');

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

function normalizeFc2Result(raw) {
    return {
        id: raw.contentId || '',
        title: raw.title || '',
        description: raw.description || '',
        date: raw.releaseDate || '',
        thumbUrl: raw.thumbUrl || '',
        posterUrl: raw.thumbUrl || '',
        siteName: raw.siteName || 'FC2',
        sourceUrl: raw.sourceUrl || '',
        performers: Array.isArray(raw.performers) ? raw.performers.map(p => typeof p === 'string' ? { name: p } : p) : [],
        tags: raw.tags || [],
        itemType: 'fc2',
        provider: 'fc2',
        raw,
    };
}

module.exports = {
    scrapeFc2Content,
    searchFc2,
    parseFc2Url,
    normalizeFc2Result,
};
