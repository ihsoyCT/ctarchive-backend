// Crawlers that run the site's JavaScript and would otherwise be counted as
// visitors and trigger Reddit lookups. Matched against the User-Agent header.

// [name, pattern]; the first match wins, so specific names come before the generic rule
const BOTS = [
    ['meta-externalagent', /meta-external(agent|fetcher)|facebookexternalhit/i],
    ['Applebot', /Applebot/i],
    ['Googlebot', /Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google|AdsBot-Google/i],
    ['Bingbot', /bingbot|BingPreview/i],
    ['OpenAI', /GPTBot|OAI-SearchBot|ChatGPT-User/i],
    ['Anthropic', /ClaudeBot|Claude-User|Claude-SearchBot/i],
    ['PerplexityBot', /Perplexity/i],
    ['Bytespider', /Bytespider/i],
    ['Amazonbot', /Amazonbot/i],
    ['YandexBot', /YandexBot|YandexRenderResolver/i],
    ['DuckDuckBot', /DuckDuckBot|DuckAssistBot/i],
    ['Baiduspider', /Baiduspider/i],
    ['PetalBot', /PetalBot/i],
    ['HeadlessChrome', /HeadlessChrome/i],
    // Anything else that says it is a bot, e.g. "AhrefsBot/7.0", "SemrushBot"
    ['other', /bot\/|bot;|crawler|spider/i],
];

/**
 * Name of the crawler sending this User-Agent, or null for a normal browser.
 * @param {string|undefined} userAgent
 * @returns {string|null}
 */
function detectBot(userAgent) {
    if (!userAgent) return null;
    for (const [name, pattern] of BOTS) {
        if (pattern.test(userAgent)) return name;
    }
    return null;
}

module.exports = { detectBot };
