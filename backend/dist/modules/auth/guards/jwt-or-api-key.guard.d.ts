import { ExecutionContext } from '@nestjs/common';
declare const JwtOrApiKeyGuard_base: import("@nestjs/passport").Type<import("@nestjs/passport").IAuthGuard>;
export declare class JwtOrApiKeyGuard extends JwtOrApiKeyGuard_base {
    canActivate(context: ExecutionContext): boolean | Promise<boolean> | import("rxjs").Observable<boolean>;
}
export {};
