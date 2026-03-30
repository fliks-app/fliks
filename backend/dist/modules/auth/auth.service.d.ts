import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { LoginDto, RegisterDto } from './dto/login.dto';
export declare class AuthService {
    private readonly userRepo;
    private readonly jwtService;
    private readonly config;
    constructor(userRepo: Repository<User>, jwtService: JwtService, config: ConfigService);
    getAccessCookieMaxAgeMs(): number;
    login(dto: LoginDto): Promise<{
        accessToken: string;
        user: User;
    }>;
    register(dto: RegisterDto): Promise<User>;
    validateApiKey(apiKey: string): Promise<User | null>;
    private localLogin;
    private generateApiKey;
}
