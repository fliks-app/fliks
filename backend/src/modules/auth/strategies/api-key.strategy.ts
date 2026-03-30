import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-http-header-strategy';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {
    super({ header: 'X-Api-Key' });
  }

  async validate(apiKey: string): Promise<User> {
    if (!apiKey) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findOne({
      where: { apiKey, enabled: true },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid API key');
    }
    return user;
  }
}
