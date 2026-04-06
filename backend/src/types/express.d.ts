import type { User } from '../modules/users/entities/user.entity';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export {};
