/**
 * TODO: réimplémenter avec une clé API globale (app_settings) au lieu de par utilisateur.
 *
 * Ancien fonctionnement (per-user) — conservé comme référence :
 *
 * - Colonne `apiKey` (unique, 32-byte hex) sur l'entité User
 * - Header HTTP : X-Api-Key
 * - Package : passport-http-header-strategy
 *
 * ```ts
 * import { Injectable, UnauthorizedException } from '@nestjs/common';
 * import { PassportStrategy } from '@nestjs/passport';
 * import { Strategy } from 'passport-http-header-strategy';
 * import { InjectRepository } from '@nestjs/typeorm';
 * import { Repository } from 'typeorm';
 * import { User } from '../../users/entities/user.entity';
 *
 * @Injectable()
 * export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
 *   constructor(
 *     @InjectRepository(User)
 *     private readonly userRepo: Repository<User>,
 *   ) {
 *     super({ header: 'X-Api-Key' });
 *   }
 *
 *   async validate(apiKey: string): Promise<User> {
 *     if (!apiKey) throw new UnauthorizedException();
 *     const user = await this.userRepo.findOne({
 *       where: { apiKey, enabled: true },
 *       relations: ['userRole'],
 *     });
 *     if (!user) throw new UnauthorizedException('Invalid API key');
 *     return user;
 *   }
 * }
 * ```
 *
 * Côté guard, réactiver avec : AuthGuard(['jwt', 'api-key'])
 * Côté auth.module, réimporter la strategy dans providers.
 */
