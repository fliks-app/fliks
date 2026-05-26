import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { CaslAbilityFactory } from './casl/casl-ability.factory';
import { PoliciesGuard } from './casl/policies.guard';
import { User } from '../users/entities/user.entity';
import { Role } from '../roles/entities/role.entity';
import { SettingsModule } from '../settings/settings.module';
import { EventsModule } from '../scheduler/events.module';
import { PairingRequest } from './pairing/entities/pairing-request.entity';
import { PairingService } from './pairing/pairing.service';
import { PairingController } from './pairing/pairing.controller';
import { RefreshToken } from './entities/refresh-token.entity';
import { RefreshTokenService } from './refresh-token.service';
import { getJwtSecret } from '../../common/utils/jwt-secret';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Role, PairingRequest, RefreshToken]),
    forwardRef(() => SettingsModule),
    EventsModule,
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
  controllers: [AuthController, PairingController],
  providers: [
    AuthService,
    JwtStrategy,
    CaslAbilityFactory,
    PoliciesGuard,
    PairingService,
    RefreshTokenService,
  ],
  exports: [AuthService, CaslAbilityFactory, PoliciesGuard, JwtModule],
})
export class AuthModule {}
