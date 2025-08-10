const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const cors = require('cors');
const port = 3030;
const auth = require('./auth'); // Import the auth module
const crypto = require('crypto');

app.set('trust proxy', true);
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

// Middleware to parse the referer data and the 'r' parameter
app.use((req, res, next) => {
    if (req.query.d) {
        try {
            req.refererData = Buffer.from(req.query.d, 'base64').toString('utf8').substring(0, 500);
        } catch (err) {
            // If it's not base64, just take the first 500 characters
            req.refererData = req.query.d.substring(0, 500);
        }
    }

    // Decode the 'r' parameter if it exists
    if (req.query.r) {
        try {
            req.refererR = Buffer.from(req.query.r, 'base64').toString('utf8').substring(0, 500);
        } catch (err) {
            // If it's not base64, just take the first 500 characters
            req.refererR = req.query.r.substring(0, 500);
        }
    } else {
        req.refererR = '';
    }

    next();
});

// API endpoint
app.get('/api', (req, res) => {
    const logDir = '/var/log/ihsoyct-ref';
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

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// New endpoint: get comment IDs from a Reddit post
app.get('/reddit-comments', async (req, res) => {
    const postParam = req.query.post;
    if (!postParam) {
        return res.status(400).send('Missing post parameter');
    }
    let postId = postParam;
    const match = postParam.match(/comments\/([a-zA-Z0-9_]+)/);
    if (match) postId = match[1];
    let clientDisconnected = false;
    res.on('close', () => {
        clientDisconnected = true;
    });
    try {
        const authHeader = await auth.getAuth();
        // Use the recursive fetch function with disconnect check
        const allComments = await fetchAllRedditComments(postId, authHeader, () => clientDisconnected);
        if (clientDisconnected) return; // Don't send response if disconnected
        // Only return IDs
        const ids = allComments.map(c => c.data?.id).filter(Boolean);
        res.json({ ids });
    } catch (error) {
        if (clientDisconnected) return;
        if (error.status === 429) {
            return res.status(429).send(error.message);
        }
        console.error('Error fetching Reddit comments:', error.message, " url: ", error.config?.url);
        console.error(error)
        res.status(500).send('Failed to fetch comments');
    }
});

// Helper to recursively fetch all comments including 'more' children
async function fetchAllRedditComments(postId, authHeader, isDisconnected) {
    const link_id = `t3_${postId}`;
    // Fetch initial comment tree
    const url = `https://oauth.reddit.com/comments/${postId}`;
    if (isDisconnected && isDisconnected()) return [];
    console.log('Requesting URL:', url);
    const data = await fetchRedditComments(url, authHeader);
    if (isDisconnected && isDisconnected()) return [];
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
    // Recursively fetch 'more' comments
    while (moreIds.length > 0) {
        if (isDisconnected && isDisconnected()) return Object.values(allComments);
        const childrenParam = moreIds.splice(0, 100).join(','); // Reddit API max 100 ids per request
        const moreUrl = `https://oauth.reddit.com/api/morechildren?link_id=${link_id}&children=${childrenParam}&api_type=json`;
        console.log('Requesting URL:', moreUrl);
        const moreData = await fetchRedditComments(moreUrl, authHeader);
        if (isDisconnected && isDisconnected()) return Object.values(allComments);
        const things = moreData?.json?.data?.things || [];
        let newMoreIds = [];
        for (const t of things) {
            if (t.kind === 't1' && t.data && t.data.id) {
                allComments[t.data.id] = t;
                // Check for replies in the newly fetched comments
                if (t.data.replies && t.data.replies.data && t.data.replies.data.children) {
                    collectComments(t.data.replies.data.children, newMoreIds);
                }
            } else if (t.kind === 'more' && t.data && Array.isArray(t.data.children)) {
                newMoreIds.push(...t.data.children);
            }
        }
        // Add any new 'more' ids to the queue
        moreIds.push(...newMoreIds);
    }
    // Return all comments as an array
    return Object.values(allComments);
}