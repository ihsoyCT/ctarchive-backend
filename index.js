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

// New endpoint: get comments from a Reddit post
app.get('/reddit-comments', async (req, res) => {
    const postParam = req.query.post;
    if (!postParam) {
        return res.status(400).send('Missing post parameter');
    }
    let postId = postParam;
    // If a full URL is provided, extract the post ID
    const match = postParam.match(/comments\/([a-zA-Z0-9_]+)/);
    if (match) postId = match[1];
    try {
        const authHeader = await auth.getAuth();
        const response = await require('axios').get(
            `https://oauth.reddit.com/comments/${postId}`,
            authHeader
        );
        // Reddit returns an array, second element is comments
        const commentsTree = response.data[1]?.data?.children || [];

        // Recursively collect all comment IDs
        function collectIds(comments) {
            let ids = [];
            for (const c of comments) {
                if (c.kind === 't1' && c.data && c.data.id) {
                    ids.push(c.data.id);
                    if (c.data.replies && c.data.replies.data && c.data.replies.data.children) {
                        ids = ids.concat(collectIds(c.data.replies.data.children));
                    }
                }
            }
            return ids;
        }
        const allIds = collectIds(commentsTree);
        res.json(allIds);
    } catch (error) {
        console.error('Error fetching Reddit comments:', error.message);
        res.status(500).send('Failed to fetch comments');
    }
});