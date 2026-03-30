import type { Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto } from './dto/login.dto';
import { User } from '../users/entities/user.entity';
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    login(dto: LoginDto, res: Response): Promise<{
        user: User;
    }>;
    logout(res: Response): void;
    register(dto: RegisterDto): Promise<User>;
    getProfile(user: User): any;
}
