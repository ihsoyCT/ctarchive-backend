const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const cors = require('cors');
const port = 3030;
const auth = require('./auth'); // Import the auth module
const crypto = require('crypto');

// nginx (with real_ip for Cloudflare) is the only trusted proxy; it appends the
// real client address as the last X-Forwarded-For entry. Trusting every hop
// would let clients choose their own IP by sending X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(cors({ origin: [ 'https://ihsoyct.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080' ] }));
app.disable('x-powered-by');

let limitDefault = 300;
let limitRemaining = limitDefault, limitResetAtMS = 0;

// Helper sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to fetch Reddit comments with rate limit handling
async function fetchRedditComments(url, axiosConfig) {
    if (limitRemaining <= 0) {
        const waitMS = limitResetAtMS - Date.now() + 1000;
        if (waitMS > 0) {
            console.log(`Rate limit reached, cancelling request`);
            // Instead of sleeping, throw an error to be handled by the endpoint
            const err = new Error('Rate limit reached, try again later');
            err.status = 429;
            throw err;
        }
        if (limitRemaining <= 0) limitRemaining = limitDefault;
    }
    limitRemaining--;
    // Always set Accept-Language
    if (!axiosConfig.headers) axiosConfig.headers = {};
    axiosConfig.headers['Accept-Language'] = 'en';
    // Make request
    const response = await require('axios').get(url, axiosConfig);
    // Read rate limit headers
    const headers = response.headers;
    const reportedLimitRemaining = parseInt(headers['x-ratelimit-remaining']);
    const reportedLimitUsed = parseInt(headers['x-ratelimit-used']);
    const reportedLimitDefault = reportedLimitRemaining + reportedLimitUsed;
    if (reportedLimitDefault && reportedLimitDefault !== limitDefault) {
        console.warn('Correcting limitDefault from', limitDefault, 'to', reportedLimitDefault);
        limitDefault = reportedLimitDefault;
    }
    const reportedLimitResetAtMS = parseInt(headers['x-ratelimit-reset']) * 1000 + Date.now();
    if (reportedLimitResetAtMS > limitResetAtMS + 30000) {
        console.debug('Resetting limitResetAtMS from', limitResetAtMS, 'to', reportedLimitResetAtMS);
        limitResetAtMS = reportedLimitResetAtMS;
    } else {
        if (reportedLimitResetAtMS < limitResetAtMS) {
            console.debug('Decreasing limitResetAtMS from', limitResetAtMS, 'to', reportedLimitResetAtMS);
            limitResetAtMS = reportedLimitResetAtMS;
        }
        if (reportedLimitRemaining < limitRemaining) {
            console.warn('Decreasing limitRemaining from', limitRemaining, 'to', reportedLimitRemaining);
            limitRemaining = reportedLimitRemaining;
        }
    }
    return response.data;
}

// Decoded values end up in line-based log files; strip control characters
// so a request cannot inject extra (forged) log lines.
function cleanLogValue(value) {
    return value.replace(/[\x00-\x1f\x7f]/g, '').substring(0, 500);
}

// Middleware to parse the referer data and the 'r' parameter
app.use((req, res, next) => {
    if (req.query.d) {
        try {
            req.refererData = cleanLogValue(Buffer.from(String(req.query.d), 'base64').toString('utf8'));
        } catch (err) {
            // If it's not base64, just take the first 500 characters
            req.refererData = cleanLogValue(String(req.query.d));
        }
    }

    // Decode the 'r' parameter if it exists
    if (req.query.r) {
        try {
            req.refererR = cleanLogValue(Buffer.from(String(req.query.r), 'base64').toString('utf8'));
        } catch (err) {
            // If it's not base64, just take the first 500 characters
            req.refererR = cleanLogValue(String(req.query.r));
        }
    } else {
        req.refererR = '';
    }

    next();
});

// API endpoint
app.get('/api', (req, res) => {
    const logDir = process.env.LOG_DIR || '/var/log/ihsoyct-ref';
    const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

    const anonIp = crypto.createHash('sha256').update(req.ip).digest('hex');

    if (!req.refererData) {
        const errorEntry = `[ERROR] - [${new Date().toISOString()}] - ${anonIp} - No referer data provided - ${JSON.stringify(req.query).substring(0, 300)}\n`;
        // Append the error entry to the file
        fs.appendFile(logFile, errorEntry, (err) => {
            if (err) {
                console.error(err);
            }
        });
        return res.status(400).send('NO');
    }
    let refererString = "";
    if(req.refererR !== '') refererString = ` - Referer: ${req.refererR}`;
    const logEntry = `[REQUEST] - [${new Date().toISOString()}] - ${anonIp} - ${req.refererData}${refererString}\n`;

    // Append the log entry to the file
    fs.appendFile(logFile, logEntry, (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('NO');
        }
        res.send('YES');
    });
});

app.listen(port, '127.0.0.1', () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Results of /reddit-comments per post id. Popular threads are opened many
// times in a row, and every uncached lookup costs several Reddit API calls.
const COMMENTS_CACHE_TTL_MS = parseInt(process.env.COMMENTS_CACHE_TTL_MIN || '15', 10) * 60 * 1000;
const COMMENTS_ERROR_TTL_MS = 5 * 60 * 1000;
const COMMENTS_CACHE_MAX = 2000;
// Each call returns up to ~100 comments; the frontend only asks for threads
// with up to 2000 comments, so this is plenty and bounds the cost of a request.
const MAX_REDDIT_CALLS_PER_POST = 30;

const commentsCache = new Map(); // postId -> { expires, status, body }
const commentsInFlight = new Map(); // postId -> Promise<{ status, body }>

function cacheComments(postId, result, ttl) {
    commentsCache.delete(postId);
    commentsCache.set(postId, { ...result, expires: Date.now() + ttl });
    // Map keeps insertion order, so the first key is the oldest entry
    while (commentsCache.size > COMMENTS_CACHE_MAX) {
        commentsCache.delete(commentsCache.keys().next().value);
    }
}

async function lookupComments(postId) {
    try {
        const authHeader = await auth.getAuth();
        const allComments = await fetchAllRedditComments(postId, authHeader);
        const result = { status: 200, body: { ids: allComments.map(c => c.data?.id).filter(Boolean) } };
        cacheComments(postId, result, COMMENTS_CACHE_TTL_MS);
        return result;
    } catch (error) {
        const status = error.status || error.response?.status;
        if (status === 429) {
            // Not cached: the limit resets within minutes
            return { status: 429, body: error.message };
        }
        if (status === 413 || status === 403 || status === 404) {
            // Too big, private/quarantined or missing: asking again soon won't help
            const result = { status, body: status === 413 ? error.message : 'Post not available on Reddit' };
            cacheComments(postId, result, COMMENTS_ERROR_TTL_MS);
            return result;
        }
        console.error('Error fetching Reddit comments:', error.message, 'url:', error.config?.url);
        return { status: 500, body: 'Failed to fetch comments' };
    }
}

// Get the ids of all comments that are still visible on Reddit for a post
app.get('/reddit-comments', async (req, res) => {
    const postParam = String(req.query.post || '');
    const match = postParam.match(/comments\/([a-zA-Z0-9]+)/);
    const postId = (match ? match[1] : postParam).toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(postId)) {
        return res.status(400).send('Missing or invalid post parameter');
    }

    const cached = commentsCache.get(postId);
    if (cached && cached.expires > Date.now()) {
        res.set('X-Cache', 'HIT');
        return res.status(cached.status).send(cached.body);
    }

    // Concurrent requests for the same post share one lookup. The lookup is
    // not cancelled when a client disconnects: the result is cached, so the
    // next viewer (or a retry after the frontend timeout) gets it instantly.
    let pending = commentsInFlight.get(postId);
    if (!pending) {
        pending = lookupComments(postId).finally(() => commentsInFlight.delete(postId));
        commentsInFlight.set(postId, pending);
    }
    const result = await pending;
    if (res.writableEnded || res.destroyed) return;
    res.set('X-Cache', 'MISS');
    res.status(result.status).send(result.body);
});

// Helper to recursively fetch all comments including 'more' children
async function fetchAllRedditComments(postId, authHeader) {
    const link_id = `t3_${postId}`;
    let calls = 0;
    const fetchCounted = async (url) => {
        if (++calls > MAX_REDDIT_CALLS_PER_POST) {
            const err = new Error('Too many comments in this post');
            err.status = 413;
            throw err;
        }
        console.log('Requesting URL:', url);
        return fetchRedditComments(url, authHeader);
    };
    // Fetch initial comment tree
    const data = await fetchCounted(`https://oauth.reddit.com/comments/${postId}`);
    const commentsTree = data[1]?.data?.children || [];
    // Store all comments by id
    const allComments = {};
    // Helper to collect 'more' ids and flatten comments
    function collectComments(comments, moreIds) {
        for (const c of comments) {
            if (c.kind === 't1' && c.data && c.data.id) {
                allComments[c.data.id] = c;
                if (c.data.replies && c.data.replies.data && c.data.replies.data.children) {
                    collectComments(c.data.replies.data.children, moreIds);
                }
            } else if (c.kind === 'more' && c.data && Array.isArray(c.data.children)) {
                moreIds.push(...c.data.children);
            }
        }
    }
    let moreIds = [];
    collectComments(commentsTree, moreIds);
    // Fetch 'more' comments, 100 ids per request (Reddit API maximum)
    while (moreIds.length > 0) {
        const childrenParam = moreIds.splice(0, 100).join(',');
        const moreData = await fetchCounted(`https://oauth.reddit.com/api/morechildren?link_id=${link_id}&children=${childrenParam}&api_type=json`);
        const things = moreData?.json?.data?.things || [];
        for (const t of things) {
            if (t.kind === 't1' && t.data && t.data.id) {
                allComments[t.data.id] = t;
                // Check for replies in the newly fetched comments
                if (t.data.replies && t.data.replies.data && t.data.replies.data.children) {
                    collectComments(t.data.replies.data.children, moreIds);
                }
            } else if (t.kind === 'more' && t.data && Array.isArray(t.data.children)) {
                moreIds.push(...t.data.children);
            }
        }
    }
    // Return all comments as an array
    return Object.values(allComments);
}