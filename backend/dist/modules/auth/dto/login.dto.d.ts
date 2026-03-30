import { MediaServerType } from '../../../common/enums';
export declare class LoginDto {
    username: string;
    password: string;
    serverType?: MediaServerType;
}
export declare class RegisterDto {
    username: string;
    password: string;
    email?: string;
}
