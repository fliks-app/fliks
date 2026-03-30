"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCookieValue = parseCookieValue;
exports.getRequestCookieHeader = getRequestCookieHeader;
function parseCookieValue(cookieHeader, cookieName) {
    if (!cookieHeader)
        return null;
    const prefix = `${cookieName}=`;
    for (const segment of cookieHeader.split(';')) {
        const part = segment.trim();
        if (part.startsWith(prefix)) {
            const raw = part.slice(prefix.length);
            try {
                return decodeURIComponent(raw);
            }
            catch {
                return raw;
            }
        }
    }
    return null;
}
function getRequestCookieHeader(req) {
    const c = req.headers?.cookie;
    if (typeof c === 'string')
        return c;
    if (Array.isArray(c))
        return c.join('; ');
    return undefined;
}
//# sourceMappingURL=request-cookie.util.js.map