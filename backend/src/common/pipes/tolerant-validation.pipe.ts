import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import type { ValidationPipeOptions } from '@nestjs/common';

const ALLOW_EXTRA_PROPERTIES = Symbol('allowExtraProperties');

/** Marks a DTO whose unknown properties are stripped instead of rejected, so a
 *  newer client sending a field this server doesn't know yet still plays. */
export function AllowExtraProperties(): ClassDecorator {
  return (target) => Reflect.defineMetadata(ALLOW_EXTRA_PROPERTIES, true, target);
}

/** Global pipe that keeps `forbidNonWhitelisted` everywhere except DTOs
 *  marked {@link AllowExtraProperties}, which only get whitelist-stripped. */
export class TolerantValidationPipe extends ValidationPipe {
  private readonly relaxed: ValidationPipe;

  constructor(options: ValidationPipeOptions) {
    super(options);
    this.relaxed = new ValidationPipe({ ...options, forbidNonWhitelisted: false });
  }

  transform(value: unknown, metadata: ArgumentMetadata) {
    const metatype = metadata.metatype;
    if (metatype && Reflect.getMetadata(ALLOW_EXTRA_PROPERTIES, metatype)) {
      return this.relaxed.transform(value, metadata);
    }
    return super.transform(value, metadata);
  }
}
