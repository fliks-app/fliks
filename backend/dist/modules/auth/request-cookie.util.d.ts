export declare function parseCookieValue(cookieHeader: string | undefined, cookieName: string): string | null;
export declare function getRequestCookieHeader(req: {
    headers?: {
        cookie?: string | string[];
    };
}): string | undefined;
