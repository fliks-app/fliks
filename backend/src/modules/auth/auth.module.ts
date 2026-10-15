import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtStrategy } from './strategies/jwt.strategy';
import { CaslAbilityFactory } from './casl/casl-ability.factory';
import { PoliciesGuard } from './casl/policies.guard';
import { User } from '../users/entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { getJwtSecret } from '../../common/utils/jwt-secret';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role]),
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Resolved from JWT_SECRET env, then <conf-dir>/.jwt-secret,
        // then auto-generated on first boot. See
        // common/utils/jwt-secret.ts.
        secret: getJwtSecret(),
        signOptions: {
          // 1h default — access tokens are now paired with a long-lived
          // refresh token (\`REFRESH_TOKEN_TTL_DAYS\`, default 60d) so
          // the user-visible session lasts effectively forever while
          // a stolen access JWT can't be replayed for more than an hour.
          expiresIn: config.get('JWT_EXPIRATION', '1h'),
        },
      }),
    }),
  ],
  providers: [JwtStrategy, CaslAbilityFactory, PoliciesGuard],
  exports: [CaslAbilityFactory, PoliciesGuard, JwtModule],
})
export class AuthModule {}
