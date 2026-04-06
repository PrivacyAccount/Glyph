const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p';

/**
 * Search TMDB for a TV series
 */
function searchSeries(query, apiKey) {
    return tmdbGet(`/search/tv?query=${encodeURIComponent(query)}&language=de-DE`, apiKey);
}

/**
 * Search TMDB for a movie
 */
function searchMovie(query, apiKey) {
    return tmdbGet(`/search/movie?query=${encodeURIComponent(query)}&language=de-DE`, apiKey);
}

/**
 * Get TV series details
 */
function getSeriesDetails(id, apiKey) {
    return tmdbGet(`/tv/${id}?language=de-DE`, apiKey);
}

/**
 * Get movie details
 */
function getMovieDetails(id, apiKey) {
    return tmdbGet(`/movie/${id}?language=de-DE`, apiKey);
}

/**
 * Download poster image and save to disk
 */
function downloadPoster(posterPath, savePath, size = 'w500') {
    return new Promise((resolve, reject) => {
        if (!posterPath) return reject(new Error('No poster path'));

        const url = `${TMDB_IMG_BASE}/${size}${posterPath}`;

        const makeRequest = (requestUrl) => {
            const client = requestUrl.startsWith('https') ? https : http;
            client.get(requestUrl, (res) => {
                // Follow redirects
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    makeRequest(res.headers.location);
                    return;
                }

                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                const dir = path.dirname(savePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                const fileStream = fs.createWriteStream(savePath);
                res.pipe(fileStream);
                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve(savePath);
                });
                fileStream.on('error', reject);
            }).on('error', reject);
        };

        makeRequest(url);
    });
}

/**
 * Save metadata JSON to a folder
 */
function saveMetadata(folderPath, metadata) {
    const metaPath = path.join(folderPath, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');
    return metaPath;
}

/**
 * Load metadata JSON from a folder
 */
function loadMetadata(folderPath) {
    const metaPath = path.join(folderPath, 'metadata.json');
    try {
        if (fs.existsSync(metaPath)) {
            return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to load metadata from', metaPath, e.message);
    }
    return null;
}

/**
 * Generic TMDB GET request
 */
function tmdbGet(endpoint, apiKey) {
    return new Promise((resolve, reject) => {
        const separator = endpoint.includes('?') ? '&' : '?';
        const url = `${TMDB_BASE}${endpoint}${separator}api_key=${apiKey}`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode !== 200) {
                        reject(new Error(parsed.status_message || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error('Invalid JSON response'));
                }
            });
        }).on('error', reject);
    });
}

/**
 * Get images (posters, backdrops) for a movie or TV show
 */
function getImages(id, type, apiKey) {
    return tmdbGet(`/${type}/${id}/images`, apiKey);
}

module.exports = {
    searchSeries,
    searchMovie,
    getSeriesDetails,
    getMovieDetails,
    getImages,
    tmdbGet,
    downloadPoster,
    saveMetadata,
    loadMetadata,
};
